// ============================================================
// Broadcast resume / retry (issue #472).
//
// The dashboard wizard drives its own send loop from the browser tab
// that started the campaign, so closing the tab abandons the campaign
// mid-flight: the remaining recipients stay 'pending' and the
// broadcast sits in 'sending' forever. This module is the recovery —
// and the same machinery answers the reporter's other two asks,
// "reprocess pending" and "reprocess failed".
//
// It deliberately reuses `deliverBroadcast` rather than growing a
// second fan-out loop: same phone-variant retry, same per-recipient
// stamping, same trigger-owned counts.
//
// What it does NOT do is move the *initial* send server-side. The
// wizard still owns that; this makes an abandoned one recoverable.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BroadcastError,
  assertHeaderMedia,
  CONSENT_FAILURE_REASONS,
  OPTED_OUT_REASON,
  quietHoursMessage,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';
import {
  resolveChannelForSurface,
  ChannelError,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  RESENDABLE_FILTER,
  SEND_UNCONFIRMED_REASON,
} from '@/lib/broadcasts/unconfirmed-send';
import { isInQuietHours, parseQuietHours } from '@/lib/broadcasts/quiet-hours';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import {
  consentRefusal,
  type ConsentRefusal,
} from '@/lib/whatsapp/send-origin';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, so it is bounded by the host's function timeout — the cap
 * keeps a 5 000-recipient backlog from being one un-completable unit
 * of work. Whatever is left stays 'pending' and the caller is told how
 * many, so the UI can offer Resume again. Matches the public API's
 * per-request recipient cap.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

/**
 * How long a `delivery_locked_at` stamp is honoured before it is read
 * as abandoned. Long enough that a legitimately slow pass is never
 * stolen from, short enough that a crashed one doesn't wedge the
 * campaign until someone touches the database.
 */
export const DELIVERY_LOCK_STALE_MS = 30 * 60 * 1000;

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock for a broadcast.
 *
 * One conditional UPDATE, so the claim is atomic: a concurrent caller's
 * WHERE no longer matches and it gets `false`. Returns false when the
 * broadcast doesn't exist on this account, too — the caller treats both
 * as "not yours to run".
 *
 * The stored timestamp is the owner's token: pass your own `now` and
 * keep `now.toISOString()` for the refresh and the release.
 */
export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(
    now.getTime() - DELIVERY_LOCK_STALE_MS
  ).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: now.toISOString() })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Keep a lock this pass holds from going stale. `token` is the lock's
 * current timestamp: the claim's `now.toISOString()`, then whatever the
 * last refresh returned. Null when the lock is no longer provably this
 * pass's own — taken over as stale, or the write failed.
 */
export async function refreshBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string,
  token: string
): Promise<string | null> {
  const next = new Date().toISOString();
  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: next })
    .eq('id', broadcastId)
    .eq('delivery_locked_at', token)
    .select('id');
  if (error) {
    console.error('[broadcast-resume] refresh failed:', error.message);
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? next : null;
}

/**
 * Release the delivery lock, if it is still the one `token` names: a
 * pass that outlived its lock must not free another pass's. Best-effort;
 * a stale lock self-expires.
 */
export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string,
  token: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId)
    .eq('delivery_locked_at', token);
  if (error) {
    console.error('[broadcast-resume] release failed:', error.message);
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  /** In-scope recipients left over after the per-request cap. */
  remaining: number;
  /**
   * In-scope rows that can never send because their contact has no
   * usable phone. Stamped 'failed' by {@link planBroadcastResume} so
   * they stop blocking the broadcast's terminal status.
   */
  unsendable: number;
  /**
   * In-scope rows whose customer has since opted out (migration 076) or
   * been marked do-not-contact (086). Left out of the plan and stamped
   * 'failed' with {@link CONSENT_FAILURE_REASONS}.
   */
  optedOut: number;
}

export { OPTED_OUT_REASON };

interface RecipientContact {
  phone?: string | null;
  opted_out_at?: string | null;
  do_not_contact_at?: string | null;
}

interface RecipientRow {
  id: string;
  template_params: unknown;
  contact_id?: string | null;
  contact: RecipientContact | RecipientContact[] | null;
}

/** Supabase renders an embedded to-one join as an object or a 1-array. */
function rowContact(row: RecipientRow): RecipientContact | null {
  return (Array.isArray(row.contact) ? row.contact[0] : row.contact) ?? null;
}

function contactPhone(row: RecipientRow): string | null {
  return rowContact(row)?.phone ?? null;
}

/** Rows per load: the most PostgREST answers with. */
const LOAD_PAGE = 1000;

/** Ids per stamp: they travel in the request URL. */
const STAMP_CHUNK = 100;

async function stampFailed(
  db: SupabaseClient,
  ids: string[],
  reason: string
): Promise<void> {
  for (let i = 0; i < ids.length; i += STAMP_CHUNK) {
    const { error } = await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: reason })
      .in('id', ids.slice(i, i + STAMP_CHUNK));
    if (error) {
      console.error('[broadcast-resume] failed stamp:', error.message);
    }
  }
}

/**
 * Build a {@link BroadcastPlan} for the recipients of an existing
 * broadcast that still need sending.
 *
 * Params come off the recipient rows (frozen at plan time by migration
 * 038) rather than being re-resolved from contact data, so a resume
 * sends what the original pass would have sent even if the contact has
 * been edited since.
 *
 * Throws {@link BroadcastError}; the route maps it.
 */
export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select(
      'id, template_name, template_language, header_media_url, quiet_hours'
    )
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError) {
    console.error('[broadcast-resume] broadcast load failed:', bcError.message);
    throw new BroadcastError('internal', 'Failed to load the broadcast', 500);
  }
  if (!broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  // Never 409 here: the wizard reads that as "a pass is running" and
  // waits for it.
  const quietHours = parseQuietHours(broadcast.quiet_hours);
  if (quietHours && isInQuietHours(new Date(), quietHours)) {
    throw new BroadcastError('quiet_hours', quietHoursMessage(quietHours), 400);
  }

  // A row still pending with the write-ahead mark was being sent when an
  // earlier pass died (the caller holds the lock, so no pass is on it
  // now). Nobody knows whether the customer got it: never sent again.
  const { error: unconfirmedErr } = await db
    .from('broadcast_recipients')
    .update({ status: 'failed' })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
    .eq('error_message', SEND_UNCONFIRMED_REASON);
  if (unconfirmedErr) {
    console.error(
      '[broadcast-resume] unconfirmed stamp failed:',
      unconfirmedErr.message
    );
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const statuses = scopeStatuses(scope);
  // Counted before anything below is stamped: PostgREST answers a load
  // with at most 1,000 rows, so the rows read say nothing about how many
  // customers are left.
  const { count: inScope, error: countError } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', statuses)
    .or(RESENDABLE_FILTER);
  if (countError || inScope === null) {
    console.error(
      '[broadcast-resume] recipient count failed:',
      countError?.message
    );
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  // A recipient whose contact has no usable phone can never send. Stamp
  // it failed now: leaving it 'pending' would keep the broadcast in
  // 'sending' forever, which is the very symptom being fixed.
  //
  // A customer who asked not to be messaged after the campaign was
  // planned (migration 076) is never sent to: their row is stamped
  // failed with the reason, which also settles the broadcast's status.
  const sendable: RecipientRow[] = [];
  const unsendable: string[] = [];
  const refused: Record<ConsentRefusal, string[]> = {
    opted_out: [],
    do_not_contact: [],
  };
  // Page until the pass is full or the rows run out: a first page of
  // customers who all opted out is not "nothing left to send".
  for (
    let from = 0;
    sendable.length < RESUME_MAX_PER_REQUEST;
    from += LOAD_PAGE
  ) {
    const { data, error: recError } = await db
      .from('broadcast_recipients')
      .select(
        'id, template_params, contact_id, contact:contacts(phone, opted_out_at, do_not_contact_at)'
      )
      .eq('broadcast_id', broadcastId)
      .in('status', statuses)
      .or(RESENDABLE_FILTER)
      // Oldest first, so repeated capped passes chew through the backlog
      // in a stable order instead of re-picking the same slice. The id
      // breaks ties: a campaign's rows share one created_at, and an
      // unstable order would repeat or skip rows between pages.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LOAD_PAGE - 1);

    if (recError) {
      console.error(
        '[broadcast-resume] recipient load failed:',
        recError.message
      );
      throw new BroadcastError('internal', 'Failed to load recipients', 500);
    }

    const rows = (data ?? []) as RecipientRow[];
    for (const row of rows) {
      const refusal = consentRefusal(rowContact(row));
      if (refusal) {
        refused[refusal].push(row.id);
        continue;
      }
      const sanitized = sanitizePhoneForMeta(contactPhone(row) ?? '');
      if (isValidE164(sanitized)) sendable.push(row);
      else unsendable.push(row.id);
    }
    if (rows.length < LOAD_PAGE) break;
  }

  // Left out of the plan whatever becomes of the stamps; the next pass
  // retries one that failed.
  for (const refusal of ['opted_out', 'do_not_contact'] as const) {
    await stampFailed(db, refused[refusal], CONSENT_FAILURE_REASONS[refusal]);
  }
  const optedOut = refused.opted_out.length + refused.do_not_contact.length;
  await stampFailed(db, unsendable, 'No valid phone number on contact');

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const remaining = Math.max(
    0,
    inScope - slice.length - optedOut - unsendable.length
  );

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  // Resolve the channel the same way `createBroadcast` did. A resume
  // deliberately RE-resolves rather than reusing whatever the original
  // run used: if an admin has since re-routed broadcasts to the other
  // number, the retry should honour that.
  let channel: WhatsAppChannel;
  try {
    channel = await resolveChannelForSurface(db, accountId, 'broadcast');
  } catch (err) {
    if (err instanceof ChannelError) {
      throw new BroadcastError(
        // Unreadable is not "no number": the cron keeps the campaign due.
        err.code === 'channel_lookup_failed' ? 'internal' : err.code,
        err.message,
        err.status
      );
    }
    throw err;
  }

  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    broadcast.template_name,
    broadcast.template_language
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — open Settings → Templates and re-save it before resuming.',
      500
    );
  }
  if (!resolvedTemplate.row) {
    throw new BroadcastError(
      'template_not_found',
      `No template named "${broadcast.template_name}" exists on this account.`,
      404
    );
  }

  const headerMediaUrl =
    typeof broadcast.header_media_url === 'string' &&
    broadcast.header_media_url.trim()
      ? broadcast.header_media_url.trim()
      : null;

  // Once per pass rather than once per recipient: a scheduled campaign
  // on a media template with no media fails here, with the reason,
  // instead of stamping every row with the builder's error.
  if (channel.provider === 'meta') {
    assertHeaderMedia(resolvedTemplate.row, headerMediaUrl);
  }

  const plan: BroadcastPlan = {
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    channelId: channel.phoneNumberId,
    channel,
    templateRow: resolvedTemplate.row,
    headerMediaUrl,
    quietHours,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      contactId: row.contact_id ?? null,
      phone: sanitizePhoneForMeta(contactPhone(row) ?? ''),
      params: Array.isArray(row.template_params)
        ? row.template_params.filter((p): p is string => typeof p === 'string')
        : [],
    })),
    rejected: 0,
    skippedOptedOut: optedOut,
  };

  return {
    plan,
    remaining,
    unsendable: unsendable.length,
    optedOut,
  };
}

/**
 * Put the broadcast back into `sending` for the duration of the pass,
 * so the detail page reads as in-flight rather than as a finished
 * campaign that is quietly still working.
 */
export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}
