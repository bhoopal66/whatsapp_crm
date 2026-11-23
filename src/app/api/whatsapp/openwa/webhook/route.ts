import { NextResponse, after } from 'next/server';
import { createHash } from 'node:crypto';
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
import { persistOwnSend, resolveOpenWALidPhone } from '@/lib/whatsapp/own-send';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';
import {
  awaitLater,
  runDeliveredEvents,
  type DeliveredEvent,
} from '@/lib/whatsapp/inbound-delivery';
import {
  groupMessagePayload,
  inboundChannel,
  messagePayload,
  ownSendPayload,
  statusPayload,
} from '@/lib/whatsapp/inbound-events';
import {
  recordInboundEvents,
  type InboundEventKind,
} from '@/lib/whatsapp/webhook-inbox';
import { serverSupabaseUrl } from '@/lib/supabase/urls';
import {
  applyGroupEvents,
  applyGroupStatuses,
  persistGroupMessages,
  type GroupChannel,
  type GroupInboundMessage,
} from '@/lib/groups/inbound';
import {
  clientIp,
  confirmAccepted,
  releaseAccepted,
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
  const normalized = normalizeOpenWAWebhook(payload);
  // Groups are company-number-only: a personal number's group traffic
  // is dropped exactly as before groups came to OpenWA.
  const event =
    config.is_personal === true
      ? { ...normalized, groupMessages: [], groupEvents: [] }
      : normalized;
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
    events: screenEvents(event, config.id, groupEventKey(event, rawBody)),
  });
  if (screen.status === 503) {
    // Another delivery holds a claim on one of these events and has not
    // finished with it: 503 so OpenWA redelivers once it has (then they
    // are duplicates) or its lease has lapsed (then they are processed).
    return NextResponse.json({ error: 'Retry later' }, { status: 503 });
  }

  const screened = applyScreen(event, screen.decisions, config);

  // Durable before the 200 (migration 264): each event is a row, and the
  // automations cron retries what this process does not finish.
  const record = await recordInboundEvents(screened.queued);
  if (record.status === 'failed') {
    // Not stored, so not acked: OpenWA delivers again, and must not find
    // its own claims in the way.
    await releaseAccepted(edgeCtx(), screen.decisions);
    return NextResponse.json({ error: 'Retry later' }, { status: 503 });
  }

  // Process AFTER the response so OpenWA gets a prompt ack, while still
  // guaranteeing the work runs to completion. Everything is awaited
  // INSIDE after(): a detached promise is dropped when the runtime
  // freezes the function after the response (issues #301, #409).
  after(async () => {
    if (screened.duplicates + screened.ipLimited > 0) {
      console.warn(
        `[openwa-webhook] skipped ${screened.duplicates} duplicate and ${screened.ipLimited} IP-limited event(s)`
      );
    }
    if (record.status === 'unavailable') {
      await processWithoutQueue(screened, screen.decisions, config);
      return;
    }
    const later: Promise<unknown>[] = [];
    const ofKind = (...kinds: InboundEventKind[]) =>
      record.events.filter((r) => kinds.includes(r.event.kind));
    // Own sends before receipts, which then find their row.
    await runDeliveredEvents(edgeCtx(), ofKind('own_send'), later);
    await runDeliveredEvents(edgeCtx(), ofKind('status', 'message'), later);
    // Not queued: group events, screened by their envelope key, so a
    // redelivery or an IP-limited delivery applies nothing twice.
    await applyOpenWAGroupEvents(config, screened.event.groupEvents);
    if (screened.unqueued.length > 0) {
      await confirmAccepted(edgeCtx(), screened.unqueued);
    }
    await runDeliveredEvents(edgeCtx(), ofKind('group_message'), later);
    await awaitLater(later);
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

/**
 * Migration 264 is not applied: process the delivery in this callback, as
 * before the queue existed. To be deleted one release after 264.
 */
async function processWithoutQueue(
  screened: ReturnType<typeof applyScreen>,
  decisions: readonly ScreenDecision[],
  config: OpenWAConfigRow
): Promise<void> {
  let groupsOk = true;
  try {
    // Groups first and isolated: a failure there never stops the inbox
    // work. Group events are screened by their envelope key, so a
    // redelivery or an IP-limited delivery applies nothing twice.
    groupsOk = await processOpenWAGroups(
      config,
      screened.event.groupMessages,
      screened.event.groupEvents,
      screened.event.statuses
    );
    await processOpenWAWebhook(screened.event, config, screened.overLimit);
  } catch (error) {
    // A claim is confirmed only once its event is persisted. These
    // lapse with their lease instead, so a redelivery is processed
    // rather than skipped as a duplicate.
    console.error('[openwa-webhook] processing failed:', error);
    return;
  }
  // Group messages whose write failed keep their claims unconfirmed,
  // so a redelivery stores them (the write is idempotent).
  if (!groupsOk) return;
  await confirmAccepted(edgeCtx(), decisions);
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
  configId: string,
  groupKey: string
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
  // Own sends next; no sender key, since they are not a sender's flood.
  for (const own of event.ownSends) {
    events.push({ key: `openwa:own:${configId}:${own.id}`, kind: 'status' });
  }
  // Group messages last, as `status` kind like the Whapi route's: replay
  // and the IP limit apply, but a busy group spends no sender budget.
  for (const message of event.groupMessages) {
    events.push({
      key: `openwa:group:${configId}:${message.id}`,
      kind: 'status',
    });
  }
  // Group events last. They carry no id, so the key is the envelope's:
  // without it a redelivered join/leave would move the member count again.
  event.groupEvents.forEach((_, i) => {
    events.push({
      key: `openwa:gevt:${configId}:${groupKey}:${i}`,
      kind: 'status',
    });
  });
  return events;
}

/**
 * What names this delivery's group events across redeliveries: the
 * envelope's idempotency key, else a hash of the signed body.
 */
function groupEventKey(
  event: NormalizedOpenWAWebhook,
  rawBody: string
): string {
  return (
    event.envelopeKey ??
    `h:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`
  );
}

/**
 * Give each event back its screening outcome: accepted events are
 * processed, a sender over the limit is kept in the inbox without
 * fan-out, duplicates and IP-limited events are skipped and counted.
 */
function applyScreen(
  event: NormalizedOpenWAWebhook,
  decisions: readonly ScreenDecision[],
  config: OpenWAConfigRow
) {
  const queued: DeliveredEvent[] = [];
  const unqueued: ScreenDecision[] = [];
  const queue = (
    decision: ScreenDecision,
    kind: InboundEventKind,
    payload: unknown
  ) =>
    queued.push({
      accountId: config.account_id,
      channel: config.id,
      provider: 'openwa',
      eventKey: decision.key,
      kind,
      payload,
      config,
      decision,
    });
  let next = 0;
  let duplicates = 0;
  let ipLimited = 0;
  const skip = (outcome: ScreenDecision['outcome']) => {
    if (outcome === 'duplicate') duplicates++;
    else ipLimited++;
  };

  const statuses: NormalizedOpenWAWebhook['statuses'] = [];
  for (const status of event.statuses) {
    const decision = decisions[next++];
    if (decision.outcome === 'accept') {
      statuses.push(status);
      queue(decision, 'status', statusPayload(status));
    } else skip(decision.outcome);
  }

  const messages: NormalizedInboundMessage[] = [];
  const overLimit = new Set<NormalizedInboundMessage>();
  for (const message of event.messages) {
    const decision = decisions[next++];
    if (decision.outcome === 'accept') {
      messages.push(message);
      queue(decision, 'message', messagePayload(message));
    } else if (decision.outcome === 'rate_limited') {
      // Never lost, never answered: into the inbox without fan-out.
      messages.push(message);
      overLimit.add(message);
      queue(decision, 'message', messagePayload(message, true));
    } else skip(decision.outcome);
  }

  const ownSends: NormalizedOpenWAWebhook['ownSends'] = [];
  for (const own of event.ownSends) {
    const decision = decisions[next++];
    if (decision.outcome === 'accept') {
      ownSends.push(own);
      // Filed only on a personal number; a company number's CRM sends are
      // already rows.
      if (config.is_personal === true) {
        queue(decision, 'own_send', ownSendPayload(own));
      } else unqueued.push(decision);
    } else skip(decision.outcome);
  }

  const groupMessages: GroupInboundMessage[] = [];
  for (const message of event.groupMessages) {
    const decision = decisions[next++];
    if (decision.outcome === 'accept') {
      groupMessages.push(message);
      queue(decision, 'group_message', groupMessagePayload(message));
    } else skip(decision.outcome);
  }

  const groupEvents: NormalizedOpenWAWebhook['groupEvents'] = [];
  for (const groupEvent of event.groupEvents) {
    const decision = decisions[next++];
    if (decision.outcome === 'accept') {
      groupEvents.push(groupEvent);
      unqueued.push(decision);
    } else skip(decision.outcome);
  }

  return {
    event: {
      ...event,
      statuses,
      messages,
      ownSends,
      groupMessages,
      groupEvents,
    },
    overLimit,
    /** What the queue records, in delivery order. */
    queued,
    /** Accepted but not recorded: confirmed once the route handled them. */
    unqueued,
    duplicates,
    ipLimited,
  };
}

/**
 * Group traffic of one authenticated callback on a company number
 * (migration 114), through the Whapi route's writers: group messages
 * into `whatsapp_group_messages`, receipts onto our group sends, `group.*`
 * events onto known groups of this number. Submission groups are
 * Whapi-only and not touched. Never throws; false when the group
 * messages could not be stored.
 */
async function processOpenWAGroups(
  config: OpenWAConfigRow,
  messages: GroupInboundMessage[],
  events: NormalizedOpenWAWebhook['groupEvents'],
  statuses: NormalizedOpenWAWebhook['statuses']
): Promise<boolean> {
  if (config.is_personal === true) return true;
  if (messages.length === 0 && events.length === 0 && statuses.length === 0) {
    return true;
  }
  const channel: GroupChannel = {
    id: config.id,
    accountId: config.account_id,
    // Our own number; NULL until the session's phone is known, which
    // only skips the "is this us" checks in `applyGroupEvents`.
    wabaId: config.waba_id ?? null,
  };
  const admin = supabaseAdmin();
  let ok = true;
  try {
    await persistGroupMessages(admin, channel, messages);
  } catch (error) {
    ok = false;
    console.error('[openwa-webhook] group messages failed:', error);
  }
  try {
    // A 1:1 receipt matches no group row, so every receipt goes here too.
    if (statuses.length > 0) await applyGroupStatuses(admin, channel, statuses);
  } catch (error) {
    console.error('[openwa-webhook] group statuses failed:', error);
  }
  await applyOpenWAGroupEvents(config, events);
  return ok;
}

/**
 * The `group.*` events of one callback. Not queued: they carry no id to
 * record them by. Never throws.
 */
async function applyOpenWAGroupEvents(
  config: OpenWAConfigRow,
  events: NormalizedOpenWAWebhook['groupEvents']
): Promise<void> {
  if (events.length === 0) return;
  const admin = supabaseAdmin();
  const channel: GroupChannel = {
    id: config.id,
    accountId: config.account_id,
    wabaId: config.waba_id ?? null,
  };
  try {
    await applyGroupEvents(admin, channel, events);
  } catch (error) {
    console.error('[openwa-webhook] group events failed:', error);
  }
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

  // Own sends are filed only on a personal number; a company number's
  // CRM sends are already rows, and its phone is not a person's.
  const ownSends = config.is_personal === true ? event.ownSends : [];
  if (event.messages.length === 0 && ownSends.length === 0) return;

  const channel = inboundChannel('openwa', config);

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

  let unresolved = 0;
  for (const own of ownSends) {
    const peerPhone =
      own.peerPhone ??
      (own.peerLid
        ? await resolveOpenWALidPhone({
            apiKey: channel.accessToken,
            sessionId: channel.phoneNumberId,
            lid: own.peerLid,
          })
        : null);
    if (!peerPhone) {
      unresolved++;
      continue;
    }
    try {
      await persistOwnSend(supabaseAdmin(), channel, {
        id: own.id,
        peerPhone,
        text: own.text,
        timestamp: own.timestamp,
      });
    } catch (err) {
      // One failed archive write must not drop the sends after it.
      console.error('[openwa-webhook] own send persist failed:', err);
    }
  }
  if (unresolved > 0) {
    console.warn(
      `[openwa-webhook] skipped ${unresolved} own send(s) to a peer with no phone number`
    );
  }
}
