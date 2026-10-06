import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { secretsMatch } from '@/lib/whatsapp/whapi-webhook-auth';
import {
  collectMetaStatuses,
  isMetaWebhookShape,
  isTemplateWebhookPayload,
  metaPhoneNumberIds,
  normalizeMetaWebhook,
  type RawMetaWebhookPayload,
} from '@/lib/whatsapp/meta-webhook';
import {
  countDroppedEvents,
  createDropTally,
} from '@/lib/whatsapp/meta-drop-tally';
import { recordMetaMessageCosts } from '@/lib/whatsapp/message-costs';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
  type TemplateWebhookChange,
} from '@/lib/whatsapp/template-webhook';
import {
  handleStatusUpdate,
  processMessage,
} from '@/lib/whatsapp/inbound-pipeline';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/**
 * Meta Cloud API webhook — the second inbound hub.
 *
 * The Whapi route (`/api/whatsapp/webhook`) is its sibling. They share
 * everything downstream via `lib/whatsapp/inbound-pipeline.ts` and
 * differ only in how a request is authenticated and how the account is
 * resolved, which really are different:
 *
 *   Whapi  a shared secret in the callback URL identifies the account;
 *          the payload's channel_id is only cross-checked afterwards,
 *          because the body is attacker-controlled and the secret is not.
 *
 *   Meta   the callback URL is configured once per APP and carries no
 *          per-account information at all. So the payload's
 *          `metadata.phone_number_id` selects the account, and the
 *          `X-Hub-Signature-256` HMAC over the raw body is what makes
 *          trusting it safe. Parsing before verifying is deliberate and
 *          confined to choosing which key to verify against — nothing
 *          acts on the payload until the signature has passed.
 *
 * Configure this URL in Meta → your App → WhatsApp → Configuration:
 *   https://<your-host>/api/whatsapp/meta/webhook
 * and subscribe at least the `messages` field.
 */

// Matches the Whapi route: inbound processing fans out to per-media
// downloads and mirror uploads, which needs headroom beyond the default.
export const maxDuration = 60;

// Lazy-initialized to avoid a build-time crash when env vars are missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

// Callbacks for numbers not connected here, summarised per id rather
// than logged per POST (see `meta-drop-tally.ts`). Module-level so the
// tally spans requests in the long-lived standalone server.
const droppedCallbacks = createDropTally();

/**
 * GET — Meta's subscription handshake.
 *
 * Meta calls this once when the callback URL is saved in the App
 * dashboard, and refuses to enable the subscription unless the
 * `hub.challenge` is echoed back verbatim as plain text.
 *
 * The token to compare against has no phone number attached (the
 * handshake predates any message), so every connected Meta channel's
 * stored `verify_token` is tried, plus `META_VERIFY_TOKEN` for a
 * single-app self-host that would rather set it by environment.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || !token || !challenge) {
    // Not a handshake — answer as a reachability probe. Reveals nothing.
    return NextResponse.json(
      {
        ok: true,
        provider: 'meta',
        message:
          'Taamul Connect Meta Cloud API webhook endpoint is reachable. Meta calls this with hub.mode=subscribe to verify.',
      },
      { status: 200 }
    );
  }

  if (await verifyTokenMatches(token)) {
    // MUST be the bare challenge as text/plain — a JSON wrapper fails
    // verification with no useful error in the App dashboard.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  console.warn(
    '[meta-webhook] handshake rejected: unrecognised hub.verify_token'
  );
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

async function verifyTokenMatches(provided: string): Promise<boolean> {
  const fromEnv = process.env.META_VERIFY_TOKEN;
  if (fromEnv && secretsMatch(provided, fromEnv)) return true;

  const { data: configs } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('verify_token')
    .eq('provider', 'meta');

  for (const config of configs ?? []) {
    if (!config.verify_token) continue;
    try {
      if (secretsMatch(provided, decrypt(config.verify_token))) return true;
    } catch {
      // Row encrypted under a rotated ENCRYPTION_KEY — skip rather than
      // failing the handshake for every other tenant.
      continue;
    }
  }
  return false;
}

/**
 * POST — the actual callback.
 *
 * Meta retries a non-200 with backoff and disables a subscription that
 * fails persistently, so this acknowledges fast and does the work in
 * `after()`, exactly as the Whapi route does. The same rule applies and
 * for the same reason (issue #301): work must be *awaited inside*
 * `after()`, never detached, or the runtime can freeze the function the
 * moment the response is sent and drop the callback mid-flight.
 */
export async function POST(request: Request) {
  // The signature is over the EXACT bytes Meta sent. Re-serialising a
  // parsed object changes key order and whitespace and will never match.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  // Everything below reads the body before its signature is checked,
  // so a body of the wrong shape must stop here rather than throw (a
  // 500 per forged POST). 200: Meta never sends one, and there is
  // nothing in it to place.
  if (!isMetaWebhookShape(parsed)) {
    console.warn('[meta-webhook] callback is not a webhook payload; ignoring');
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }
  const payload: RawMetaWebhookPayload = parsed;

  // One POST can mix two concerns, and each half is looked up and
  // verified on its own terms against the same body. Template lifecycle
  // events (review result, quality, components) carry no phone number to
  // route on — they are WABA-level. `messages` changes are per number.
  // Neither half may short-circuit the other: returning after the
  // template half used to answer 200 for a batch whose customer
  // messages and receipts never ran, and Meta does not redeliver a 200.
  const template = isTemplateWebhookPayload(payload)
    ? await templateHalf(payload, rawBody, signature)
    : null;
  if (template?.lookupFailed) return lookupFailed();

  // One POST can batch several numbers (Meta groups by app). Each is
  // resolved to its own account, authenticated with its own key, and
  // processed as its own channel — filing everything under the first
  // number would put one account's customers in another's inbox.
  const phoneNumberIds = metaPhoneNumberIds(payload);
  let phone: HalfResult | null = null;
  if (phoneNumberIds.length > 0) {
    phone = await phoneNumberHalf(payload, phoneNumberIds, rawBody, signature);
    if (phone.lookupFailed) return lookupFailed();
  } else if (!template) {
    // No metadata.phone_number_id — nothing we can route. 200 so Meta
    // does not retry a payload we will never be able to place.
    console.warn(
      '[meta-webhook] callback carried no phone_number_id; ignoring'
    );
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  // Messages first: they are what a customer is waiting on.
  const work = [phone?.work, template?.work].filter(
    (run): run is () => Promise<void> => run != null
  );
  if (work.length > 0) {
    after(async () => {
      for (const run of work) {
        try {
          await run();
        } catch (error) {
          console.error('[meta-webhook] processing failed:', error);
        }
      }
    });
  }

  // 401 rather than a silent 200 so a misconfigured app secret shows up
  // loudly in Meta's delivery log instead of being eaten. Still 401 when
  // the OTHER half verified and its work is queued above: Meta retries
  // the whole body, and replaying it is idempotent (see `lookupFailed`).
  if (template?.unauthorized || phone?.unauthorized) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  return NextResponse.json(
    { status: work.length > 0 ? 'received' : 'ignored' },
    { status: 200 }
  );
}

/**
 * What one half of a callback — its template changes, or its
 * phone-number changes — came to once its lookups and signatures ran.
 * Nothing in it has run yet: POST queues `work` in `after()`.
 */
interface HalfResult {
  /** Verified work, or null when nothing in the half verified. */
  work: (() => Promise<void>) | null;
  /** It named a WABA or number connected here, and nothing verified. */
  unauthorized: boolean;
  /** The database could not say whether an id is connected here. */
  lookupFailed: boolean;
}

const NOTHING_TO_DO: HalfResult = {
  work: null,
  unauthorized: false,
  lookupFailed: false,
};

const LOOKUP_FAILED: HalfResult = {
  work: null,
  unauthorized: false,
  lookupFailed: true,
};

/**
 * 503 when the database could not say whether an id in the callback is
 * connected here. Treating the failure as "not connected" answered 200,
 * so a connected number's message or a template decision was dropped
 * and never redelivered. Meta retries a 5xx with backoff, and a replay
 * is idempotent: the `messages` upsert ignores duplicates, the status
 * ladder only moves forward, the cost ledger is ON CONFLICT DO NOTHING,
 * and template changes set absolute values. Nothing is queued first.
 */
function lookupFailed(): Response {
  return NextResponse.json({ error: 'Lookup failed' }, { status: 503 });
}

/**
 * The `messages` half: every distinct `metadata.phone_number_id`,
 * resolved to its own account and verified with its own key.
 */
async function phoneNumberHalf(
  payload: RawMetaWebhookPayload,
  phoneNumberIds: string[],
  rawBody: string,
  signature: string | null
): Promise<HalfResult> {
  // Every lookup first: one that fails part-way must not leave a tally
  // line calling an earlier, connected number "unconnected".
  const found: { phoneNumberId: string; config: MetaConfigRow | null }[] = [];
  for (const phoneNumberId of phoneNumberIds) {
    const lookup = await findMetaConfigByPhoneNumberId(phoneNumberId);
    if (lookup.failed) return LOOKUP_FAILED;
    found.push({ phoneNumberId, config: lookup.row });
  }

  const verified: Array<{
    event: ReturnType<typeof normalizeMetaWebhook>;
    config: MetaConfigRow;
    rawStatuses: ReturnType<typeof collectMetaStatuses>[number]['status'][];
  }> = [];
  let knownButUnverified = false;
  let signedHere: Promise<boolean> | null = null;

  for (const { phoneNumberId, config } of found) {
    if (!config) {
      // Not ours (a shared app, or a number disconnected here). Skipped,
      // not failed: failing would make Meta retry forever and
      // eventually disable the subscription. Tallied rather than logged
      // per POST — one such number once filled most of the app log.
      signedHere ??= signedByThisApp(rawBody, signature);
      const line = droppedCallbacks.record(phoneNumberId, {
        ...countDroppedEvents(payload, phoneNumberId),
        signed: await signedHere,
      });
      if (line) console.warn(line);
      continue;
    }

    // Now authenticate. The lookup above only chose which key to use;
    // the signature is what proves the payload. A stored per-account
    // secret wins over the environment so a multi-tenant install works.
    let appSecret: string | null = null;
    if (config.app_secret) {
      try {
        appSecret = decrypt(config.app_secret);
      } catch {
        appSecret = null;
      }
    }
    if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
      knownButUnverified = true;
      console.warn(
        `[meta-webhook] bad or missing signature for phone_number_id "${phoneNumberId}"`
      );
      continue;
    }

    verified.push({
      event: normalizeMetaWebhook(payload, phoneNumberId),
      config,
      // Raw receipts for the cost ledger. Kept apart from the
      // normalised event because `pricing` — what Meta bills on — is
      // Meta-only and has no place in the provider-neutral shape.
      rawStatuses: collectMetaStatuses(payload)
        .filter((s) => s.phoneNumberId === phoneNumberId)
        .map((s) => s.status),
    });
  }

  if (verified.length === 0) {
    return { ...NOTHING_TO_DO, unauthorized: knownButUnverified };
  }

  return {
    ...NOTHING_TO_DO,
    work: async () => {
      for (const { event, config, rawStatuses } of verified) {
        try {
          await processMetaEvent(event, config);
        } catch (error) {
          console.error('[meta-webhook] processing failed:', error);
        }
        // Costing runs LAST and fails open (migration 051): a rate-card
        // problem must never cost an inbound message its fan-out, and a
        // thrown error here would only be logged anyway — the order is
        // what keeps the ledger from delaying the pipeline.
        if (rawStatuses.length > 0) {
          await recordMetaMessageCosts(supabaseAdmin(), {
            accountId: config.account_id,
            phoneNumberId: config.phone_number_id,
            statuses: rawStatuses,
          });
        }
      }
    },
  };
}

/**
 * Template lifecycle callbacks (approval, rejection, quality changes).
 *
 * These arrive on the same URL but carry no phone number. They are
 * WABA-level, and each `entry.id` is the WABA id, so that is what picks
 * the account: `entry.id` → the Meta `whatsapp_config` row(s) with that
 * `waba_id` → verify the HMAC with THAT row's app secret (or the
 * environment's, when the row stores none — the same rule as the
 * message path) → apply the entry's changes scoped to that row's
 * `account_id` only.
 *
 * This used to accept a signature from ANY stored app secret and then
 * update `message_templates` by `meta_template_id` across every
 * account — so an admin who controls their own app secret could sign a
 * forged callback that flipped another tenant's template status.
 * Fails closed for a WABA connected here: no entry verified → 401.
 */
async function templateHalf(
  payload: RawMetaWebhookPayload,
  rawBody: string,
  signature: string | null
): Promise<HalfResult> {
  // Only entries that carry a template change. In a mixed batch the
  // `messages` entry's WABA verifying must not pass for the template
  // half — that half answers for its own entries.
  const wabaIds = [
    ...new Set(
      (payload.entry ?? [])
        .filter((entry) =>
          (entry.changes ?? []).some(
            (change) => !!change.field && isTemplateWebhookField(change.field)
          )
        )
        .map((entry) => (entry.id == null ? '' : String(entry.id)))
        .filter(Boolean)
    ),
  ];

  let rows: {
    account_id: string;
    waba_id: string | null;
    app_secret: string | null;
  }[] = [];
  if (wabaIds.length > 0) {
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, waba_id, app_secret')
      .eq('provider', 'meta')
      .in('waba_id', wabaIds);
    if (error) {
      // Not "no WABA connected here": that answer is a 200, and a
      // decision for the connected WABA would stay PENDING for good.
      console.error('[meta-webhook] template WABA lookup failed:', error);
      return LOOKUP_FAILED;
    }
    rows = ((data ?? []) as typeof rows).filter(
      (row) => !!row.waba_id && wabaIds.includes(row.waba_id)
    );
  }

  // No WABA in this callback is connected here — a shared app, or a WABA
  // subscribed to this app for a number handled elsewhere. Acknowledge
  // and touch nothing, WITHOUT a signature check, exactly as the message
  // path skips an unknown phone_number_id. There is no stored secret to
  // check with, and falling back to META_APP_SECRET answered 401 on
  // installs that keep the secret on the row instead; Meta retries a
  // 401 and eventually disables the app's subscription — the one the
  // connected number's own messages arrive on.
  if (rows.length === 0) return NOTHING_TO_DO;

  // WABA id → accounts whose own secret verified this exact body.
  const verified = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.waba_id) continue;
    let secret: string | null = null; // null = fall back to META_APP_SECRET
    if (row.app_secret) {
      try {
        secret = decrypt(row.app_secret);
      } catch {
        secret = null;
      }
    }
    if (!verifyMetaWebhookSignature(rawBody, signature, secret)) continue;
    const accounts = verified.get(row.waba_id) ?? new Set<string>();
    accounts.add(row.account_id);
    verified.set(row.waba_id, accounts);
  }

  if (verified.size === 0) {
    console.warn(
      '[meta-webhook] template callback failed signature verification'
    );
    return { ...NOTHING_TO_DO, unauthorized: true };
  }

  return {
    ...NOTHING_TO_DO,
    work: async () => {
      for (const entry of payload.entry ?? []) {
        const accounts = verified.get(entry.id == null ? '' : String(entry.id));
        if (!accounts) continue;
        for (const change of entry.changes ?? []) {
          if (!change.field || !isTemplateWebhookField(change.field)) continue;
          for (const accountId of accounts) {
            try {
              await handleTemplateWebhookChange(
                change as TemplateWebhookChange,
                supabaseAdmin(),
                accountId
              );
            } catch (error) {
              console.error('[meta-webhook] template change failed:', error);
            }
          }
        }
      }
    },
  };
}

/**
 * Does this body verify against an app secret stored here (or
 * META_APP_SECRET)? Only for the drop tally: it tells whether a callback
 * for an unconnected number was delivered by THIS app — a WABA
 * subscribed to it — or by another app whose callback URL points here.
 * Nothing acts on the answer, and it never throws.
 */
async function signedByThisApp(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!signature) return false;
  try {
    const secrets = new Set<string>();
    if (process.env.META_APP_SECRET) secrets.add(process.env.META_APP_SECRET);
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('app_secret')
      .eq('provider', 'meta');
    for (const row of (data ?? []) as { app_secret: string | null }[]) {
      if (!row.app_secret) continue;
      try {
        secrets.add(decrypt(row.app_secret));
      } catch {
        continue;
      }
    }
    // Only ever called WITH a secret: the verifier logs an error for
    // every call that has none, which would be a line per POST again.
    for (const secret of secrets) {
      if (verifyMetaWebhookSignature(rawBody, signature, secret)) return true;
    }
  } catch (error) {
    console.error(
      '[meta-webhook] app-secret lookup for the tally failed:',
      error
    );
  }
  return false;
}

/**
 * The `whatsapp_config` row for a Meta number, as `select('*')` returns
 * it — credentials still ciphertext. Only the columns this route reads
 * are named; `toChannel` in `channels.ts` is the canonical decoder.
 */
interface MetaConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  app_secret: string | null;
  verify_token: string | null;
  is_primary: boolean | null;
  mirror_inbound_media: boolean | null;
  status: string | null;
}

/**
 * Resolve the account from the number the message arrived on.
 *
 * `phone_number_id` is UNIQUE across the table (migration 013, kept by
 * 046), so this is an indexed single-row lookup — unlike the Whapi
 * route's secret scan, which has to decrypt every row because it
 * matches on ciphertext.
 */
async function findMetaConfigByPhoneNumberId(
  phoneNumberId: string
): Promise<{ row: MetaConfigRow | null; failed: boolean }> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'meta')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) {
    // `failed`, not a null row: a null row means "not connected here",
    // which is answered 200 and tallied as a drop — for what may well
    // be the connected number.
    console.error('[meta-webhook] config lookup failed:', error);
    return { row: null, failed: true };
  }
  return { row: data, failed: false };
}

/**
 * Hand a verified event to the shared pipeline.
 *
 * Everything past this point is identical to the Whapi path — contact
 * dedup, the idempotency boundary, the status ladder, Flows →
 * automations → AI auto-reply → outbound webhooks.
 */
async function processMetaEvent(
  event: ReturnType<typeof normalizeMetaWebhook>,
  config: MetaConfigRow
) {
  for (const status of event.statuses) {
    await handleStatusUpdate(status, config.account_id);
  }

  if (event.messages.length === 0) return;

  const channel: WhatsAppChannel = {
    id: config.id,
    accountId: config.account_id,
    provider: 'meta',
    label: config.label ?? null,
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
    appSecret: null,
    isPrimary: config.is_primary === true,
    // Meta media URLs expire even faster than Whapi's (minutes, not
    // days) once resolved, so mirroring matters more here, not less.
    mirrorInboundMedia: config.mirror_inbound_media !== false,
    status: config.status ?? 'connected',
  };

  // Background work of each message (TypeSafe's watch), awaited once
  // the whole delivery is processed — still inside after().
  const later: Promise<unknown>[] = [];
  for (const message of event.messages) {
    await processMessage(
      message,
      config.account_id,
      config.user_id,
      channel,
      later
    );
  }
  await Promise.all(later);
}
