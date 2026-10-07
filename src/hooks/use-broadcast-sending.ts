'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { BATCH_SEND_ATTEMPTS, batchRetryDelayMs } from '@/lib/broadcast-retry';
import { Contact, MessageTemplate } from '@/types';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import {
  isInQuietHours,
  nextAllowedSendTime,
  type QuietHours,
} from '@/lib/broadcasts/quiet-hours';
import {
  csvValuesForContact,
  indexCsvRowsByPhone,
  resolveVariables,
  type CsvContactRow,
  type VariableMapping,
} from '@/lib/broadcasts/variables';
import {
  COMPASS_AUDIENCE_COLUMNS,
  compassOrderSpec,
  compassRowToCsvRow,
  compassReadIsConsistent,
  COMPASS_CHANGED_DURING_READ,
  COMPASS_CHECK_FAILED,
  normalizeCompassSelection,
  readCompassWindow,
  type CompassAudienceRow,
  type CompassOrder,
  type CompassSelection,
} from '@/lib/broadcasts/compass-audience';
import { partitionRowsByPhone } from '@/lib/contacts/phone-validation';

export type { CsvContactRow, VariableMapping };

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv' | 'compass';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvContactRow[];
  /**
   * Header names of the uploaded CSV (lower-cased), so the personalize
   * step can offer them as variable sources. Set for `csv`, and for
   * `compass` from the step-2 sample's fields.
   */
  csvColumns?: string[];
  /** Which slice of `compass_contacts` a `compass` audience takes. */
  compass?: CompassSelection;
  /**
   * First row of the step-2 sample of a `compass` audience — drives the
   * personalize preview ONLY. The sample is at most a page of the
   * slice, so the send path never reads it: `resolveAudience` re-reads
   * the whole slice from `compass_contacts`.
   */
  compassSample?: CsvContactRow;
  /** `compassSelectionKey` of the selection `compassSample` was read for. */
  compassSampleKey?: string;
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
  /**
   * Frequency cap: drop contacts who were sent any campaign in the last
   * N days (migration 053 — stored in `audience_filter`). 0/undefined =
   * off. Counts a recipient row at or past 'sent'; a failed send is not
   * a contact who was messaged.
   */
  skipRecentDays?: number;
}

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
  /**
   * When set, the campaign is written as 'scheduled' for this instant
   * and delivered by `GET /api/whatsapp/broadcast/cron` instead of from
   * this tab (migration 053).
   */
  scheduledAt?: Date | null;
  /**
   * Do-not-send window. A "send now" that falls inside it is turned
   * into a schedule for the moment the window ends; the cron applies
   * the same rule to a scheduled send.
   */
  quietHours?: QuietHours | null;
  /**
   * Flow started for each recipient on their first reply (migration
   * 054). Persisted on the row; the inbound pipeline reads it.
   */
  followUpFlowId?: string | null;
}

export interface BroadcastOutcome {
  broadcastId: string;
  /** Set when the campaign was scheduled rather than sent from this tab. */
  scheduledFor: Date | null;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (
    payload: BroadcastPayload
  ) => Promise<BroadcastOutcome>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Resolve the moment a campaign should go out: an explicit schedule,
 * or now — pushed past the quiet-hours window in either case. Null
 * means "send from this tab right now". Pure, so the wizard can show
 * the same answer before the confirm click.
 */
export function resolveSendTime(
  now: Date,
  scheduledAt: Date | null | undefined,
  quietHours: QuietHours | null | undefined
): Date | null {
  const base =
    scheduledAt && scheduledAt.getTime() > now.getTime() ? scheduledAt : null;
  if (!quietHours) return base;
  const at = base ?? now;
  if (!isInQuietHours(at, quietHours)) return base;
  return nextAllowedSendTime(at, quietHours);
}

/** `broadcast_recipients` inserts per request. */
const INSERT_BATCH_SIZE = 200;
const INSERT_CONCURRENCY = 4;

/**
 * How often the tab re-reads the broadcast row while a server-side
 * delivery pass runs — only for campaigns bigger than one pass
 * (RESUME_MAX_PER_REQUEST), which need the next pass started after
 * this one releases its lock.
 */
const PASS_POLL_MS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rows per page when reading a whole audience. PostgREST silently caps
 * every response at its `max-rows` (1 000 on a stock Supabase), so a
 * single unbounded `select` of an audience bigger than that sent the
 * campaign to the first 1 000 contacts and dropped the rest without a
 * word.
 */
const AUDIENCE_PAGE = 1000;

type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

/**
 * Read every row of a query, page by page. Stops on an EMPTY page
 * rather than a short one: an install whose `max-rows` is below
 * AUDIENCE_PAGE answers every page short, and treating that as the end
 * would reintroduce the truncation this exists to prevent. The query
 * must have a stable order for the offsets to mean anything.
 */
async function fetchAllPages<T>(
  page: (from: number, to: number) => PageResult<T>,
  what: string
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(
      rows.length,
      rows.length + AUDIENCE_PAGE - 1
    );
    if (error) throw new Error(`Failed to fetch ${what}: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

/**
 * The rows a `compass` audience is drawn from, in the selection's order:
 * customers with a phone (so "100 numbers" means 100 numbers), ordered
 * with `id` as a tiebreak in the same direction so offsets are stable.
 * Shared by the wizard's count and sample and by the send, so the slice
 * the admin previewed is the slice that is sent.
 */
export function compassAudienceQuery(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  order: CompassOrder
) {
  const spec = compassOrderSpec(order);
  return supabase
    .from('compass_contacts')
    .select(COMPASS_AUDIENCE_COLUMNS)
    .eq('account_id', accountId)
    .not('phone_normalized', 'is', null)
    .order(spec.column, { ascending: spec.ascending, nullsFirst: false })
    .order('id', { ascending: spec.ascending });
}

/**
 * Read a `compass` audience's window, bracketed by a check that the list
 * did not change underneath the offset paging (see
 * `compassReadIsConsistent`): the newest `updated_at` and the filtered
 * count before, the count and the rows stamped since after. Throws
 * rather than return a window that may hold the wrong customers.
 */
async function readCompassAudience(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  selection: CompassSelection
): Promise<CompassAudienceRow[]> {
  const filteredCount = async () => {
    const { count, error } = await supabase
      .from('compass_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('phone_normalized', 'is', null);
    if (error || count === null) throw new Error(COMPASS_CHECK_FAILED);
    return count;
  };

  // Every row, phone or not: setting or clearing a phone moves a row in
  // or out of the filtered list, and the sync stamps it either way.
  const newest = await supabase
    .from('compass_contacts')
    .select('updated_at')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(1);
  if (newest.error) throw new Error(COMPASS_CHECK_FAILED);
  // Kept as the string Postgres sent: through a JS Date it would lose
  // its microseconds, and the newest row would count as changed.
  const marker = (newest.data?.[0]?.updated_at as string | undefined) ?? null;
  const countBefore = await filteredCount();

  let requests = 0;
  const rows = await readCompassWindow<CompassAudienceRow>(
    (from, to) => {
      requests++;
      return compassAudienceQuery(supabase, accountId, selection.order).range(
        from,
        to
      );
    },
    selection,
    AUDIENCE_PAGE,
    'Compass contacts'
  );
  // One request is one statement, which is already a snapshot — the
  // usual "100 numbers" window. Judging it anyway would abort a send
  // over an ERP edit to some unrelated customer. A `limit: null` read
  // always ends with an extra (empty) request, so it is always judged.
  if (requests <= 1) return rows;

  const countAfter = await filteredCount();
  // With no row before the read (no marker), any row now is a change.
  let changed = supabase
    .from('compass_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId);
  if (marker !== null) changed = changed.gt('updated_at', marker);
  const changedRes = await changed;
  if (changedRes.error || changedRes.count === null) {
    throw new Error(COMPASS_CHECK_FAILED);
  }

  if (
    !compassReadIsConsistent({
      before: { count: countBefore },
      after: { count: countAfter, changedSince: changedRes.count },
    })
  ) {
    throw new Error(COMPASS_CHANGED_DURING_READ);
  }
  return rows;
}

interface ResumeResponse {
  error?: string;
  code?: string;
  /** Recipients left for a further pass (backlog over one pass's cap). */
  remaining?: number;
}

/**
 * Deliver a broadcast's pending recipients through
 * `POST /api/whatsapp/broadcast/[id]/resume`, which runs the fan-out
 * server-side. Returns once the last pass has been CLAIMED — the
 * messages go out after this resolves, and the detail page polls the
 * row for progress.
 *
 * One pass covers up to RESUME_MAX_PER_REQUEST recipients. For a
 * bigger campaign the tab waits for each pass to release the delivery
 * lock and starts the next, so the whole audience still goes out from
 * one click; if the tab closes in between, the leftovers stay
 * 'pending' and the detail page offers Resume.
 */
async function deliverOnServer(
  supabase: ReturnType<typeof createClient>,
  broadcastId: string,
  total: number,
  onProgress: (pct: number) => void = () => {}
): Promise<void> {
  for (let pass = 0; ; pass++) {
    let res: Response;
    let data: ResumeResponse = {};
    // Wait out a 429 rather than failing the campaign; nothing else is
    // retried (see batchRetryDelayMs).
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'pending' }),
      });
      data = await res.json().catch(() => ({}));
      const retryIn =
        !res.ok && attempt < BATCH_SEND_ATTEMPTS
          ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
          : null;
      if (retryIn === null) break;
      await sleep(retryIn);
    }

    if (res.status === 409) {
      // A pass is still running (ours, from the previous iteration, if
      // its lock outlived the last poll). Wait for it, then go again.
      await waitForDeliveryPass(supabase, broadcastId, total, onProgress);
      continue;
    }
    if (!res.ok) {
      if (data.code === 'nothing_to_resume') {
        // First pass: every recipient lacked a usable phone and the
        // planner has already stamped them failed — settle the
        // campaign as failed rather than leaving it 'sending'. A later
        // pass: a concurrent Resume took the rest; nothing to do.
        if (pass === 0) {
          await supabase
            .from('broadcasts')
            .update({ status: 'failed' })
            .eq('id', broadcastId);
        }
        return;
      }
      throw new Error(data.error || 'Failed to start the broadcast delivery');
    }
    if (!data.remaining) return;
    await waitForDeliveryPass(supabase, broadcastId, total, onProgress);
  }
}

/** Poll until the running delivery pass releases its lock. */
async function waitForDeliveryPass(
  supabase: ReturnType<typeof createClient>,
  broadcastId: string,
  total: number,
  onProgress: (pct: number) => void
): Promise<void> {
  for (;;) {
    await sleep(PASS_POLL_MS);
    const { data } = await supabase
      .from('broadcasts')
      .select('delivery_locked_at, sent_count, failed_count')
      .eq('id', broadcastId)
      .maybeSingle();
    if (!data) return;
    const done = (data.sent_count ?? 0) + (data.failed_count ?? 0);
    onProgress(30 + Math.min(60, Math.round((done / Math.max(total, 1)) * 60)));
    if (!data.delivery_locked_at) return;
  }
}

/** Drop the join column an `!inner` filter embeds on each contact. */
function stripEmbed<T extends object>(row: T, key: string): Contact {
  const contact = { ...row } as Record<string, unknown>;
  delete contact[key];
  return contact as unknown as Contact;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[]
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST caps the .in(...) IN-clause roughly at 1000
  // values. Page through to stay safe.
  //
  // Keep this page well under that cap for a second reason: PostgREST
  // echoes the whole `?contact_id=in.(...)` filter back in the
  // `Content-Location` response header, and 500 uuids is already ~20 KB
  // of header for a reverse proxy to buffer (see docs/docker.md, and
  // the chunked lookup in upsertCsvContacts below).
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  /**
   * The audience's contacts, plus the CSV-shaped rows they were made
   * from (a CSV upload, or a Compass slice) so a `csv_column` mapping
   * can read each recipient's own row.
   */
  async function resolveAudience(
    audience: AudienceConfig
  ): Promise<{ contacts: Contact[]; csvRows: CsvContactRow[] }> {
    const supabase = createClient();

    let contacts: Contact[] = [];
    let csvRows: CsvContactRow[] = [];

    if (audience.type === 'all') {
      contacts = await fetchAllPages<Contact>(
        (from, to) =>
          supabase.from('contacts').select('*').order('id').range(from, to),
        'contacts'
      );
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      // One filtered query rather than "fetch the tag's contact ids,
      // then `.in('id', ids)`": thousands of uuids in a GET URL
      // overflow the proxy, and the id list itself was capped at
      // max-rows. `!inner` returns each contact once however many of
      // the selected tags it carries.
      const tagIds = audience.tagIds;
      const rows = await fetchAllPages<Contact & { contact_tags: unknown }>(
        (from, to) =>
          supabase
            .from('contacts')
            .select('*, contact_tags!inner(tag_id)')
            .in('contact_tags.tag_id', tagIds)
            .order('id')
            .range(from, to),
        'contacts'
      );
      contacts = rows.map((row) => stripEmbed(row, 'contact_tags'));
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(
        supabase,
        audience.customField
      );
    } else if (audience.type === 'csv' && audience.csvContacts) {
      csvRows = audience.csvContacts;
      contacts = await upsertCsvContacts(supabase, csvRows);
    } else if (audience.type === 'compass') {
      // Compass customers live in `compass_contacts`, not `contacts`, so
      // they go through the CSV path to become real contacts (deduped
      // on the normalized phone, created when missing). The slice is
      // read here, in full — never the wizard's sample. A number the
      // contact rules refuse is dropped exactly as a CSV upload's is.
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }
      const selection = normalizeCompassSelection(audience.compass);
      // This runs before the broadcast row exists, so a read that
      // fails its consistency check throws with nothing created.
      const rows = await readCompassAudience(supabase, accountId, selection);
      csvRows = partitionRowsByPhone(rows.map(compassRowToCsvRow)).valid;
      contacts = await upsertCsvContacts(supabase, csvRows);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const excludeTagIds = audience.excludeTagIds;
      const excludeRows = await fetchAllPages<{ contact_id: string }>(
        (from, to) =>
          supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', excludeTagIds)
            .order('id')
            .range(from, to),
        'excluded contacts'
      );
      const excludedIds = new Set(excludeRows.map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    // Frequency cap: anyone already sent a campaign in the window is
    // dropped, whatever list they came from (CSV included — a phone
    // uploaded twice in a week is exactly the case).
    const days = audience.skipRecentDays ?? 0;
    if (days > 0 && contacts.length > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const recent = await fetchAllPages<{ contact_id: string }>(
        (from, to) =>
          supabase
            .from('broadcast_recipients')
            .select('contact_id')
            .in('status', ['sent', 'delivered', 'read', 'replied'])
            .gte('sent_at', cutoff)
            .order('id')
            .range(from, to),
        'recent recipients for the frequency cap'
      );
      const recentIds = new Set(recent.map((r) => r.contact_id));
      contacts = contacts.filter((c) => !recentIds.has(c.id));
    }

    return { contacts, csvRows };
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: CsvContactRow[]
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // De-duplicate by NORMALIZED phone (digits only), within the CSV and
    // against the database. Contacts are unique per account on
    // `phone_normalized` (migration 022), so "+971 50 123 4567" in the
    // file and "971501234567" already in the CRM — whoever on the team
    // created it — are the same contact. Matching on the raw string and
    // only the current user's rows tripped that unique index with
    // "duplicate key value violates idx_contacts_account_phone_normalized".
    const uniqueByPhone = new Map<string, CsvContactRow>();
    for (const row of csvRows) {
      const key = normalizePhone(row.phone);
      if (key && !uniqueByPhone.has(key)) uniqueByPhone.set(key, row);
    }
    const keys = [...uniqueByPhone.keys()];

    // Look up existing contacts account-wide (RLS scopes the account) on
    // the same normalized column the index uses.
    //
    // This was a single round trip for the whole file until a ~400-row
    // CSV came back as a wall of Cloudflare "502 Bad gateway" HTML in
    // place of an error message. The request was fine: PostgREST echoes
    // the entire `?phone_normalized=in.(...)` filter back in the
    // `Content-Location` RESPONSE header, so a long list overflows the
    // reverse proxy's response-header buffer and the call fails 502
    // while the identical query straight to PostgREST returns 200.
    // Chunking bounds that header from the app's side, whatever proxy
    // an install sits behind; 200 matches INSERT_CHUNK below and keeps
    // the echoed header near 2 KB.
    const LOOKUP_CHUNK = 200;
    const byPhone = new Map<string, Contact>();
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const { data: existing, error: lookupErr } = await supabase
        .from('contacts')
        .select('*')
        .in('phone_normalized', keys.slice(i, i + LOOKUP_CHUNK));
      if (lookupErr) {
        throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
      }
      for (const c of (existing ?? []) as Contact[]) {
        const key = normalizePhone(c.phone ?? '');
        if (key) byPhone.set(key, c);
      }
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = keys
      .filter((k) => !byPhone.has(k))
      .map((k) => ({
        user_id: user.id,
        account_id: accountId,
        phone: uniqueByPhone.get(k)!.phone,
        name: uniqueByPhone.get(k)?.name ?? null,
        company: uniqueByPhone.get(k)?.company ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        const key = normalizePhone(c.phone ?? '');
        if (key) byPhone.set(key, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return keys
      .map((k) => byPhone.get(k))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // One filtered query over contacts, with the condition applied to
    // the embedded value row (`!inner` keeps only contacts that have a
    // matching one) — same semantics as matching contact_custom_values
    // first, without shipping the id list back up in a URL. PostgREST
    // supports eq/neq/ilike on embedded columns; "contains" uses ilike
    // with wildcards so the match is case-insensitive.
    const rows = await fetchAllPages<
      Contact & { contact_custom_values: unknown }
    >((from, to) => {
      let query = supabase
        .from('contacts')
        .select('*, contact_custom_values!inner(value)')
        .eq('contact_custom_values.custom_field_id', fieldId);
      if (operator === 'is')
        query = query.eq('contact_custom_values.value', value);
      else if (operator === 'is_not')
        query = query.neq('contact_custom_values.value', value);
      else if (operator === 'contains')
        query = query.ilike('contact_custom_values.value', `%${value}%`);
      return query.order('id').range(from, to);
    }, 'contacts for the custom-field filter');
    return rows.map((row) => stripEmbed(row, 'contact_custom_values'));
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload
  ): Promise<BroadcastOutcome> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    // Decided once, up front, so the row is written in its final state:
    // either this tab sends it now, or the cron sends it at `sendAt`.
    const sendAt = resolveSendTime(
      new Date(),
      payload.scheduledAt ?? null,
      payload.quietHours ?? null
    );

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const { contacts, csvRows } = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted. Persisted on the row (migration 053) so a
      // scheduled or resumed pass sends the same asset.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
            skipRecentDays: payload.audience.skipRecentDays || undefined,
            compass:
              payload.audience.type === 'compass'
                ? normalizeCompassSelection(payload.audience.compass)
                : undefined,
          },
          header_media_url: messageParams?.headerMediaUrl ?? null,
          quiet_hours: payload.quietHours ?? null,
          follow_up_flow_id: payload.followUpFlowId ?? null,
          scheduled_at: sendAt ? sendAt.toISOString() : null,
          status: sendAt ? 'scheduled' : 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params. Those params are what makes
      // the campaign resumable server-side (issue #472): the send loop
      // below runs in this browser tab, and if the tab goes away the
      // only record of what {{1}} should be for each contact is this
      // column. Resolving once here also means the resume sends exactly
      // what this pass would have.
      // A `csv_column` mapping reads the recipient's own CSV row: the
      // contact row we upserted may pre-date the upload and carry a
      // different name, but the column the admin picked is what they
      // saw in the file, so that is what goes out. A Compass slice is
      // indexed the same way, from the rows resolveAudience read.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id)
      );
      const csvIndex = indexCsvRowsByPhone(csvRows);
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
            csvValuesForContact(csvIndex, contact)
          ),
        ])
      );
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
      }));

      // A few inserts in flight at once: each is a tunnel round trip,
      // and they are independent rows.
      const batches: (typeof recipientRows)[] = [];
      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        batches.push(recipientRows.slice(i, i + INSERT_BATCH_SIZE));
      }
      for (let i = 0; i < batches.length; i += INSERT_CONCURRENCY) {
        const results = await Promise.all(
          batches
            .slice(i, i + INSERT_CONCURRENCY)
            .map((batch) => supabase.from('broadcast_recipients').insert(batch))
        );
        const failedAt = results.findIndex((r) => r.error);
        if (failedAt !== -1) {
          const recipientError = results[failedAt].error!;
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw before anything is sent.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i + failedAt + 1}: ${recipientError.message}`
          );
        }
      }

      // Scheduled: the rows are in place, the cron takes it from here.
      if (sendAt) {
        setProgress(100);
        return { broadcastId: broadcast.id, scheduledFor: sendAt };
      }

      // ── Step 4: Hand delivery to the server ───────────────────────
      // The rows are frozen (params included), so the send itself is
      // exactly what the detail page's Resume runs: claim the delivery
      // lock, plan from the pending rows, fan out in `after()` at the
      // origin. This used to be a loop in this tab — a POST per 10
      // recipients plus one UPDATE per recipient, every one of them a
      // round trip through the tunnel, so 1 000 recipients took ~10
      // minutes with the tab pinned open. Server-side it is one call,
      // and closing the tab no longer abandons the campaign.
      setProgress(30);
      await deliverOnServer(
        supabase,
        broadcast.id,
        contacts.length,
        setProgress
      );

      return { broadcastId: broadcast.id, scheduledFor: null };
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
