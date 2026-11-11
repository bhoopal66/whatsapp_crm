import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  normalizeOpenWAWebhook,
  type NormalizedOpenWAWebhook,
  type RawOpenWAWebhookPayload,
} from '@/lib/whatsapp/openwa-webhook';
import { verifyOpenWAWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import {
  handleStatusUpdate,
  processMessage,
} from '@/lib/whatsapp/inbound-pipeline';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';
import { serverSupabaseUrl } from '@/lib/supabase/urls';
import {
  clientIp,
  confirmAccepted,
  RateLimiter,
  ReplayGuard,
  RpcRateStore,
  RpcSeenStore,
  screenWebhook,
  type ScreenCtx,
  type ScreenDecision,
  type ScreenEvent,
} from '@/lib/edge';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to media downloads and mirror uploads,
// so give it headroom beyond the platform default.
export const maxDuration = 60;

// Lazy-initialized to avoid build-time crash when env vars are missing
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

// Edge screening (module 017a), the same pair as the other two hubs'.
// Claims and counters live in migration 084's tables, so one pair per
// process serves every request.
let _edgeCtx: ScreenCtx | null = null;
function edgeCtx(): ScreenCtx {
  if (!_edgeCtx) {
    const admin = supabaseAdmin();
    _edgeCtx = {
      replay: new ReplayGuard(new RpcSeenStore(admin)),
      limiter: new RateLimiter(new RpcRateStore(admin)),
    };
  }
  return _edgeCtx;
}

/**
 * POST /api/whatsapp/openwa/webhook
 *
 * OpenWA (a self-hosted linked-device gateway) posts one event per
 * request and signs the raw body with the number's webhook secret.
 * Authentication runs in Meta's direction: the URL carries nothing
 * account-specific, so the payload's `sessionId` SELECTS the number (an
 * indexed lookup on `phone_number_id`) and the HMAC over the raw body
 * PROVES it. Reading the body before verifying is confined to choosing
 * which key to verify with; an attacker can name any session, but
 * cannot sign for it.
 *
 * Status codes are chosen for OpenWA's redelivery: 503 for our own
 * lookup failure (it retries), 200 for a session with no number here (a
 * non-2xx would make it retry forever), 401 for a bad signature. Never
 * 429 — that only brings a retry.
 */
export async function POST(request: Request) {
  // The signature is over the EXACT bytes OpenWA sent. Re-serialising a
  // parsed object changes key order and whitespace and will never match.
  const rawBody = await request.text();
  const signature = request.headers.get('x-openwa-signature');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  // The session id is read before the signature is checked, so a body
  // of the wrong shape stops here rather than reaching the lookup.
  // OpenWA never sends one, so a 400 costs no redelivery.
  if (!isOpenWAWebhookShape(parsed)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  const payload = parsed;

  const lookup = await findOpenWAConfigBySessionId(payload.sessionId);
  if (lookup.failed) {
    return NextResponse.json({ error: 'Lookup failed' }, { status: 503 });
  }
  const config = lookup.row;
  if (!config) {
    // The number was removed (or never connected here) while the
    // gateway still points at us. Not logged with the session id: an
    // operator may have named it after the phone number.
    console.warn(
      '[openwa-webhook] callback for a session with no connected number; ignoring'
    );
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  // A secret that will not decrypt (rotated ENCRYPTION_KEY, corrupt
  // row) verifies nothing: fail closed, like a wrong signature.
  let secret: string | null = null;
  try {
    secret = config.verify_token ? decrypt(config.verify_token) : null;
  } catch {
    secret = null;
  }
  if (!verifyOpenWAWebhookSignature(rawBody, signature, secret)) {
    console.warn('[openwa-webhook] rejected callback with a bad signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Pure and never throws on a well-shaped body; normalised before the
  // response only because screening keys on the message list.
  const event = normalizeOpenWAWebhook(payload);
  if (event.unmappedLidSenders > 0) {
    // Counted, not identified: a lid is a privacy id, and neither it nor
    // the body belongs in a log.
    console.warn(
      `[openwa-webhook] dropped ${event.unmappedLidSenders} message(s) from a sender with no phone number`
    );
  }

  // Edge screening: one call per request, after the signature has
  // authenticated it.
  const screen = await screenWebhook(edgeCtx(), {
    ip: clientIp(request.headers),
    events: screenEvents(event, config.id),
  });
  if (screen.status === 503) {
    // Another delivery holds a claim on one of these events and has not
    // finished with it: 503 so OpenWA redelivers once it has (then they
    // are duplicates) or its lease has lapsed (then they are processed).
    return NextResponse.json({ error: 'Retry later' }, { status: 503 });
  }

  // Process AFTER the response so OpenWA gets a prompt ack, while still
  // guaranteeing the work runs to completion. Everything is awaited
  // INSIDE after(): a detached promise is dropped when the runtime
  // freezes the function after the response (issues #301, #409).
  after(async () => {
    const screened = applyScreen(event, screen.decisions);
    try {
      if (screened.duplicates + screened.ipLimited > 0) {
        console.warn(
          `[openwa-webhook] skipped ${screened.duplicates} duplicate and ${screened.ipLimited} IP-limited event(s)`
        );
      }
      await processOpenWAWebhook(screened.event, config, screened.overLimit);
    } catch (error) {
      // A claim is confirmed only once its event is persisted. These
      // lapse with their lease instead, so a redelivery is processed
      // rather than skipped as a duplicate.
      console.error('[openwa-webhook] processing failed:', error);
      return;
    }
    await confirmAccepted(edgeCtx(), screen.decisions);
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

type OpenWAPayload = RawOpenWAWebhookPayload & { sessionId: string };

function isOpenWAWebhookShape(value: unknown): value is OpenWAPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    typeof v.event === 'string'
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenWAConfigRow = any;

/**
 * Resolve the number from the session the event names. An OpenWA row's
 * `phone_number_id` is its session id, and the column is UNIQUE across
 * providers, so this is an indexed single-row lookup.
 */
async function findOpenWAConfigBySessionId(
  sessionId: string
): Promise<{ row: OpenWAConfigRow | null; failed: boolean }> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'openwa')
    .eq('phone_number_id', sessionId)
    .maybeSingle();

  if (error) {
    // `failed`, not a null row: a null row means "not connected here",
    // which is answered 200 — for what may well be the connected number.
    console.error('[openwa-webhook] config lookup failed:', error);
    return { row: null, failed: true };
  }
  return { row: data, failed: false };
}

/**
 * The events edge screening judges: statuses, then messages, which is
 * the order `applyScreen` reads the decisions back in.
 *
 * Keys name the config row the signature authenticated, never the
 * payload's session id, so one tenant's callbacks cannot claim
 * another's events.
 */
function screenEvents(
  event: NormalizedOpenWAWebhook,
  configId: string
): ScreenEvent[] {
  const events: ScreenEvent[] = [];
  for (const status of event.statuses) {
    events.push({
      key: `openwa:status:${configId}:${status.messageId}:${status.status}`,
      kind: 'status',
    });
  }
  for (const message of event.messages) {
    events.push({
      key: `openwa:${configId}:${message.id}`,
      senderKey: message.from || message.chatId,
      kind: 'message',
    });
  }
  return events;
}

/**
 * Give each event back its screening outcome: accepted events are
 * processed, a sender over the limit is kept in the inbox without
 * fan-out, duplicates and IP-limited events are skipped and counted.
 */
function applyScreen(
  event: NormalizedOpenWAWebhook,
  decisions: readonly ScreenDecision[]
) {
  let next = 0;
  let duplicates = 0;
  let ipLimited = 0;
  const skip = (outcome: ScreenDecision['outcome']) => {
    if (outcome === 'duplicate') duplicates++;
    else ipLimited++;
  };

  const statuses: NormalizedOpenWAWebhook['statuses'] = [];
  for (const status of event.statuses) {
    const { outcome } = decisions[next++];
    if (outcome === 'accept') statuses.push(status);
    else skip(outcome);
  }

  const messages: NormalizedInboundMessage[] = [];
  const overLimit = new Set<NormalizedInboundMessage>();
  for (const message of event.messages) {
    const { outcome } = decisions[next++];
    if (outcome === 'accept') messages.push(message);
    else if (outcome === 'rate_limited') {
      // Never lost, never answered: into the inbox without fan-out.
      messages.push(message);
      overLimit.add(message);
    } else skip(outcome);
  }

  return {
    event: { ...event, statuses, messages },
    overLimit,
    duplicates,
    ipLimited,
  };
}

/**
 * Turn one authenticated OpenWA callback into CRM state through the
 * shared pipeline.
 */
async function processOpenWAWebhook(
  event: NormalizedOpenWAWebhook,
  config: OpenWAConfigRow,
  // Messages from a sender over the webhook rate limit (module 017a).
  overLimit: ReadonlySet<NormalizedInboundMessage>
) {
  for (const status of event.statuses) {
    // Confined to the authenticated account (migration 062).
    await handleStatusUpdate(status, config.account_id);
  }

  if (event.messages.length === 0) return;

  // Shaped by hand like the Whapi route's: this runs on the service role
  // with the row already in hand, one fewer query on the hot path.
  const channel: WhatsAppChannel = {
    id: config.id,
    accountId: config.account_id,
    provider: 'openwa',
    label: config.label ?? null,
    // The session id, which is what the OpenWA client addresses.
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
    appSecret: null,
    isPrimary: config.is_primary !== false,
    // Advisory for OpenWA: the pipeline mirrors its media regardless,
    // because the gateway's own link is not browser-loadable.
    mirrorInboundMedia: config.mirror_inbound_media !== false,
    status: config.status ?? 'connected',
    // A person's own number (migration 190): the pipeline files and
    // records its messages but runs no bot on it.
    isPersonal: config.is_personal === true,
    personalUserId:
      config.is_personal === true ? (config.user_id ?? null) : null,
  };

  // Background work of each message (TypeSafe's watch), awaited once
  // the whole delivery is processed — still inside after().
  const later: Promise<unknown>[] = [];
  for (const message of event.messages) {
    await processMessage(
      message,
      config.account_id,
      // Sender-of-record for inserts needing a NOT NULL user_id FK.
      config.user_id,
      channel,
      later,
      overLimit.has(message) ? { fanOut: false } : undefined
    );
  }
  await Promise.all(later);
}
