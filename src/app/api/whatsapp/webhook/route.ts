import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  extractWebhookSecret,
  secretsMatch,
} from '@/lib/whatsapp/whapi-webhook-auth'
import {
  normalizeWhapiWebhook,
  type NormalizedWhapiWebhook,
  type RawWhapiWebhookPayload,
} from '@/lib/whatsapp/whapi-webhook'
import {
  handleStatusUpdate,
  processMessage,
} from '@/lib/whatsapp/inbound-pipeline'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound'
import {
  awaitLater,
  runDeliveredEvents,
  type DeliveredEvent,
} from '@/lib/whatsapp/inbound-delivery'
import {
  groupMessagePayload,
  inboundChannel,
  messagePayload,
  statusPayload,
} from '@/lib/whatsapp/inbound-events'
import {
  recordInboundEvents,
  type InboundEventKind,
} from '@/lib/whatsapp/webhook-inbox'
import { serverSupabaseUrl } from '@/lib/supabase/urls'
import {
  applyGroupEvents,
  applyGroupStatuses,
  extractWhapiGroupMessages,
  persistGroupMessages,
  type GroupChannel,
  type GroupInboundMessage,
} from '@/lib/groups/inbound'
import {
  parseWhapiGroupEvents,
  type WhapiGroupEvent,
} from '@/lib/whatsapp/whapi-group-events'
import {
  recordSubmissionGroupInbound,
  recordSubmissionGroupMembership,
} from '@/lib/submission-groups/inbound'
import { caseIntakeQueueFor, caseSlaInboundHook } from '@/lib/cases/server'
import type { CaseIntakeQueue } from '@/lib/case-files/intake-queue'
import { recordGroupCustomerText } from '@/lib/brain/sink'
import {
  groupDocumentFiler,
  type GroupDocumentFiler,
} from '@/lib/customer-docs/group-documents'
import { SubmissionGroupStore } from '@/lib/submission-groups/store'
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
} from '@/lib/edge'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media downloads and mirror
// uploads, so give it headroom beyond the platform default.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// Edge screening (module 017a), the same pair as the Meta route's. The
// guard and the limiter keep nothing in memory — claims and counters
// live in migration 084's tables, shared by every instance — so one pair
// per process serves every request. Lazy for the same build-time reason
// as the client above.
let _edgeCtx: ScreenCtx | null = null
function edgeCtx(): ScreenCtx {
  if (!_edgeCtx) {
    const admin = supabaseAdmin()
    _edgeCtx = {
      replay: new ReplayGuard(new RpcSeenStore(admin)),
      limiter: new RateLimiter(new RpcRateStore(admin)),
    }
  }
  return _edgeCtx
}

/**
 * GET /api/whatsapp/webhook
 *
 * Meta required this route to answer a `hub.challenge` handshake before
 * it would deliver anything. Whapi has no such handshake — a channel is
 * pointed at a URL via `PATCH /settings` and delivery begins.
 *
 * The endpoint is kept as a reachability probe: an operator (or the
 * "Test connection" button) can confirm the deployment is publicly
 * resolvable and that a given secret is recognised, which is by far the
 * most common thing to get wrong when standing this up behind a tunnel.
 *
 * It reveals nothing without a valid secret.
 */
export async function GET(request: Request) {
  const secret = extractWebhookSecret(request)

  if (!secret) {
    return NextResponse.json(
      {
        ok: true,
        provider: 'whapi',
        message:
          'Taamul Connect Whapi webhook endpoint is reachable. Append ?secret=<your webhook secret> to verify a channel.',
      },
      { status: 200 },
    )
  }

  const lookup = await findConfigByWebhookSecret(secret)
  if (lookup.failed) {
    return NextResponse.json(
      { ok: false, error: 'Lookup failed' },
      { status: 503 },
    )
  }
  const config = lookup.row
  if (!config) {
    return NextResponse.json(
      { ok: false, error: 'Unrecognised webhook secret.' },
      { status: 403 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      provider: 'whapi',
      channel_id: config.phone_number_id,
      message: 'Secret recognised. This channel is wired to deliver here.',
    },
    { status: 200 },
  )
}

/**
 * POST /api/whatsapp/webhook
 *
 * Whapi's callback. Delivered as `POST` with the full event in the body
 * (the channel is registered in `mode: 'body'`), and retried on a
 * non-200 for as long as `callback_persist` allows.
 */
export async function POST(request: Request) {
  const secret = extractWebhookSecret(request)

  // Resolve the config from the SECRET, not from the payload's
  // `channel_id`. The body is attacker-controlled; the secret is the
  // only authenticated fact in the request, so it drives tenancy.
  const lookup = secret
    ? await findConfigByWebhookSecret(secret)
    : { failed: false, row: null }
  if (lookup.failed) {
    // Our database, not their secret: Whapi has to come back.
    return NextResponse.json({ error: 'Lookup failed' }, { status: 503 })
  }
  const config = lookup.row

  if (!config) {
    // 401 rather than a silent 200: Whapi's delivery log should show
    // failures loudly if a rotation or a stale tunnel URL breaks the
    // wiring, instead of us quietly eating every event.
    console.warn('[whapi-webhook] rejected callback with missing/unknown secret')
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 })
  }

  let payload: RawWhapiWebhookPayload
  try {
    payload = (await request.json()) as RawWhapiWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalised before the response because screening keys on the
  // message list and the queue stores it.
  let event: NormalizedWhapiWebhook
  // Group traffic (migration 114) is read from the same body on its own:
  // the normaliser keeps dropping group chats, so none of it can reach
  // the inbox pipeline. Both readers are pure and never throw.
  let groupMessages: GroupInboundMessage[]
  let groupEvents: WhapiGroupEvent[]
  try {
    event = normalizeWhapiWebhook(payload)
    groupMessages = extractWhapiGroupMessages(payload)
    groupEvents = parseWhapiGroupEvents(payload)
  } catch (error) {
    // A body that cannot be read now will not read better on a retry,
    // so it is acked and logged, as it was when this ran in after().
    console.error('[whapi-webhook] processing failed:', error)
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  // Edge screening (module 017a): one call per request, after the
  // secret has authenticated it. Never a 429 — that only brings a retry.
  const screen = await screenWebhook(edgeCtx(), {
    ip: clientIp(request.headers),
    events: screenEvents(event, groupMessages, config.id),
  })
  if (screen.status === 503) {
    // Another delivery holds a claim on one of these events and has not
    // finished with it: 503 so Whapi redelivers once it has (then they
    // are duplicates) or its lease has lapsed (then they are processed).
    // Nothing is queued.
    return NextResponse.json({ error: 'Retry later' }, { status: 503 })
  }

  const screened = applyScreen(event, groupMessages, screen.decisions, config)

  // Checked before anything is queued: a delivery of another channel is
  // dropped whole, never stored under this number.
  const matches = await channelMatches(event, config)

  // Durable before the 200 (migration 264): each event is a row, and the
  // automations cron retries what this process does not finish.
  const record = await recordInboundEvents(matches ? screened.queued : [])
  if (record.status === 'failed') {
    // Not stored, so not acked: Whapi delivers again, and must not find
    // its own claims in the way.
    await releaseAccepted(edgeCtx(), screen.decisions)
    return NextResponse.json({ error: 'Retry later' }, { status: 503 })
  }

  // Process AFTER the response so Whapi gets a prompt ack (a slow ack
  // triggers redelivery and duplicate work), while still guaranteeing
  // the work runs to completion.
  //
  // This MUST use `after()` rather than a detached promise: on
  // serverless platforms the function can be frozen the moment the
  // response is sent, which non-deterministically dropped a subset of
  // inbound messages (issue #301). `after()` hands the callback to the
  // runtime, which keeps the function alive until it resolves.
  after(async () => {
    if (screened.duplicates + screened.ipLimited > 0) {
      console.warn(
        `[whapi-webhook] skipped ${screened.duplicates} duplicate and ${screened.ipLimited} IP-limited event(s)`,
      )
    }
    if (!matches) {
      // Dropped on purpose: a redelivery would be dropped again.
      await confirmAccepted(edgeCtx(), screen.decisions)
      return
    }
    // Group events carry no id to screen, so an IP-limited delivery skips
    // them along with everything else.
    const liveGroupEvents = screened.ipLimited > 0 ? [] : groupEvents
    if (record.status === 'unavailable') {
      await processWithoutQueue(
        screened,
        liveGroupEvents,
        screen.decisions,
        config,
      )
      return
    }
    // Group messages last: each one files its document inside its event
    // (gateway download + storage upload), and a slow gateway must not
    // hold the 1:1 messages past this callback's budget.
    const later: Promise<unknown>[] = []
    const inGroup = record.events.filter(
      (r) => r.event.kind === 'group_message',
    )
    const oneToOne = record.events.filter(
      (r) => r.event.kind !== 'group_message',
    )
    await runDeliveredEvents(edgeCtx(), oneToOne, later)
    await applyWhapiGroupEvents(config, liveGroupEvents)
    await runDeliveredEvents(edgeCtx(), inGroup, later)
    await awaitLater(later)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/**
 * Migration 264 is not applied: process the delivery in this callback, as
 * before the queue existed. To be deleted one release after 264.
 */
async function processWithoutQueue(
  screened: ReturnType<typeof applyScreen>,
  groupEvents: WhapiGroupEvent[],
  decisions: readonly ScreenDecision[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
): Promise<void> {
  let groupsOk = true
  // A customer's document or photo in a submission group is filed in
  // their documents folder (178). The group loop only collects it; the
  // copy (gateway download + storage upload) runs in the finally below,
  // after the 1:1 messages, so a slow gateway never holds them past
  // this callback's budget, and it still runs when processing threw.
  const filer = groupDocumentFiler({
    admin: supabaseAdmin(),
    channel: () => inboundChannel('whapi', config),
  })
  // Tap-to-classify (183): collected in the group loop like the filer,
  // run after it, since a document's customer_documents row exists only
  // once it has been filed. Off by default: the switch writes nothing.
  const intake = caseIntakeQueueFor(supabaseAdmin())
  try {
    // Groups first and isolated: a failure there is logged and never
    // stops the inbox work below.
    groupsOk = await processWhapiGroups(
      config,
      screened.groupMessages,
      groupEvents,
      screened.event.statuses,
      filer,
      intake,
    )
    await processWhapiWebhook(screened.event, config, screened.overLimit)
  } catch (error) {
    // A claim is confirmed only once its event is persisted. These
    // lapse with their lease instead, so a redelivery is processed
    // rather than skipped as a duplicate.
    console.error('[whapi-webhook] processing failed:', error)
    return
  } finally {
    // Never throws. Runs after the return above too: the documents'
    // group messages are already stored, and a redelivery would not
    // file them again (only a newly recorded message is collected).
    await filer.run()
    await intake.run()
  }
  // Group messages whose write failed keep their claims unconfirmed,
  // so a redelivery stores them (the insert is idempotent anyway).
  await confirmAccepted(
    edgeCtx(),
    groupsOk
      ? decisions
      : decisions.filter((d) => !d.key.startsWith(GROUP_KEY_PREFIX)),
  )
}

/**
 * The events edge screening judges: statuses, then messages, which is
 * the order `applyScreen` reads the decisions back in.
 *
 * Keys name the config row the SECRET resolved — never the payload's
 * `channel_id`, which is attacker-controlled — so one tenant's callbacks
 * cannot claim another's events. The row id rather than its
 * `phone_number_id` because the first callback replaces that phone
 * placeholder with the real channel id, and a key must not change under
 * a redelivery.
 */
const GROUP_KEY_PREFIX = 'whapi:group:'

function screenEvents(
  event: NormalizedWhapiWebhook,
  groupMessages: readonly GroupInboundMessage[],
  configId: string,
): ScreenEvent[] {
  const events: ScreenEvent[] = []
  for (const status of event.statuses) {
    events.push({
      key: `whapi:status:${configId}:${status.messageId}:${status.status}`,
      kind: 'status',
    })
  }
  for (const message of event.messages) {
    events.push({
      key: `whapi:${configId}:${message.id}`,
      senderKey: message.from || message.chatId,
      kind: 'message',
    })
  }
  // Group messages last. Screened as `status` kind: replay and the IP
  // limit apply, but a busy group never spends a sender's message
  // budget (and nothing in a group is answered anyway).
  for (const message of groupMessages) {
    events.push({
      key: `${GROUP_KEY_PREFIX}${configId}:${message.id}`,
      kind: 'status',
    })
  }
  return events
}

/**
 * Give each event back its screening outcome. Accepted events are
 * processed as before; a sender over the limit has the message kept in
 * the inbox without fan-out; duplicates and IP-limited events are
 * skipped, and only counted.
 */
function applyScreen(
  event: NormalizedWhapiWebhook,
  groupMessages: readonly GroupInboundMessage[],
  decisions: readonly ScreenDecision[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
) {
  const queued: DeliveredEvent[] = []
  const queue = (
    decision: ScreenDecision,
    kind: InboundEventKind,
    payload: unknown,
  ) =>
    queued.push({
      accountId: config.account_id,
      channel: config.id,
      provider: 'whapi',
      eventKey: decision.key,
      kind,
      payload,
      config,
      decision,
    })
  let next = 0
  let duplicates = 0
  let ipLimited = 0
  const skip = (outcome: ScreenDecision['outcome']) => {
    if (outcome === 'duplicate') duplicates++
    else ipLimited++
  }

  const statuses: NormalizedWhapiWebhook['statuses'] = []
  for (const status of event.statuses) {
    const decision = decisions[next++]
    // Statuses are never sender-limited: accepted, or skipped.
    if (decision.outcome === 'accept') {
      statuses.push(status)
      queue(decision, 'status', statusPayload(status))
    } else skip(decision.outcome)
  }

  const messages: NormalizedInboundMessage[] = []
  const overLimit = new Set<NormalizedInboundMessage>()
  for (const message of event.messages) {
    const decision = decisions[next++]
    if (decision.outcome === 'accept') {
      messages.push(message)
      queue(decision, 'message', messagePayload(message))
    } else if (decision.outcome === 'rate_limited') {
      // Never lost, never answered: into the inbox without fan-out.
      messages.push(message)
      overLimit.add(message)
      queue(decision, 'message', messagePayload(message, true))
    } else skip(decision.outcome)
  }

  const groups: GroupInboundMessage[] = []
  for (const message of groupMessages) {
    const decision = decisions[next++]
    if (decision.outcome === 'accept') {
      groups.push(message)
      queue(decision, 'group_message', groupMessagePayload(message))
    } else skip(decision.outcome)
  }

  return {
    event: { ...event, statuses, messages },
    groupMessages: groups,
    overLimit,
    /** What the queue records, in delivery order. */
    queued,
    duplicates,
    ipLimited,
  }
}

/**
 * Find the `whatsapp_config` row whose webhook secret matches.
 *
 * Secrets are stored encrypted, so this cannot be a WHERE clause — every
 * row is decrypted and compared in constant time. Installs have a few
 * Whapi rows per account (one per number since migration 060, each with
 * its own secret) and a handful of accounts at most; if that ever
 * stops being true, store a SHA-256 of the secret in an indexed column
 * and look it up directly.
 */
async function findConfigByWebhookSecret(
  secret: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ failed: boolean; row: any | null }> {
  const { data: configs, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    // Whapi rows only. A Meta row's `verify_token` holds the
    // hub.challenge token, which is a different credential in a
    // different namespace — scanning it would be both wasted
    // decryption and a chance to match the wrong channel.
    .eq('provider', 'whapi')

  if (error || !configs) {
    console.error('[whapi-webhook] could not load configs:', error)
    return { failed: true, row: null }
  }

  for (const config of configs) {
    if (!config.verify_token) continue
    let stored: string
    try {
      stored = decrypt(config.verify_token)
    } catch {
      // Row encrypted under a rotated ENCRYPTION_KEY — skip it rather
      // than failing the whole lookup for every other tenant.
      continue
    }
    if (secretsMatch(secret, stored)) return { failed: false, row: config }
  }

  return { failed: false, row: null }
}

/**
 * Is this row still carrying the phone-number placeholder rather than a
 * real Whapi channel id?
 *
 * The save path writes `phone_number_id = <operator input> ?? channel.phone`
 * and `waba_id = channel.phone`. The two are equal exactly when the
 * fallback was taken, which is the only case where the channel-id guard
 * has nothing real to compare against.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPhoneFallbackChannelId(config: any): boolean {
  return (
    !!config.waba_id &&
    config.phone_number_id === config.waba_id
  )
}

/**
 * Record the channel id learned from an authenticated callback.
 *
 * Best-effort: a failure here costs us the stricter guard on later
 * messages, but must never stop THIS message from being delivered —
 * dropping customer mail to preserve a defence-in-depth check would be
 * the worse trade. A UNIQUE violation means another account already
 * claimed this channel, which is logged loudly and left alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function adoptChannelId(config: any, channelId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({ phone_number_id: channelId, updated_at: new Date().toISOString() })
    // Scoped to THIS row by id. Keyed on account_id alone it would
    // stamp the Whapi channel id onto the account's Meta row too,
    // breaking that number's inbound routing (phone_number_id is what
    // the Meta webhook matches on).
    .eq('id', config.id)

  if (error) {
    console.error(
      `[whapi-webhook] could not adopt channel id "${channelId}":`,
      error,
    )
    return
  }

  config.phone_number_id = channelId
  console.log(
    `[whapi-webhook] learned channel id "${channelId}" for account ${config.account_id} (was the phone-number placeholder).`,
  )
}

/**
 * Cross-check the callback's channel against the row the secret
 * resolved (adopting the real id over the phone placeholder). False
 * means drop the whole delivery, group traffic included.
 */
async function channelMatches(
  event: NormalizedWhapiWebhook,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
): Promise<boolean> {
  // The secret already proved which account this is. A channel_id that
  // disagrees means the operator pointed a *second* channel at a URL
  // minted for the first — messages would land in the wrong account, so
  // refuse rather than mis-file them.
  //
  // ...unless we never learned the real channel id in the first place.
  // `/health` does not expose it, so the save path falls back to the
  // connected phone number to satisfy the UNIQUE constraint. A phone
  // number can never equal a Whapi channel id (`NIGHTW-JJC9J`), so with
  // the fallback in place this guard rejected EVERY inbound callback —
  // outbound sending looked perfectly healthy while nothing a customer
  // wrote ever arrived. Adopt the id the authenticated callback carries
  // instead, which makes the guard meaningful from the next message on.
  if (event.channelId && config.phone_number_id) {
    if (isPhoneFallbackChannelId(config)) {
      await adoptChannelId(config, event.channelId)
    } else if (event.channelId !== config.phone_number_id) {
      console.error(
        `[whapi-webhook] channel mismatch: callback says "${event.channelId}" but this secret belongs to "${config.phone_number_id}". Dropping.`,
      )
      return false
    }
  }
  return true
}

/**
 * Group traffic of one authenticated callback (migration 114): group
 * messages into `whatsapp_group_messages` (and those of submission
 * groups through `sg_record_inbound`), receipts onto our group sends,
 * `groups` events onto known groups of this number. Service
 * role, confined to the row the secret resolved. Never throws; false
 * when the group messages could not be stored.
 */
async function processWhapiGroups(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  messages: GroupInboundMessage[],
  events: WhapiGroupEvent[],
  statuses: NormalizedWhapiWebhook['statuses'],
  filer: Pick<GroupDocumentFiler, 'hook'>,
  intake: Pick<CaseIntakeQueue, 'document' | 'text'>,
): Promise<boolean> {
  const channel: GroupChannel = {
    id: config.id,
    accountId: config.account_id,
    wabaId: config.waba_id ?? null,
  }
  const admin = supabaseAdmin()
  let ok = true
  try {
    await persistGroupMessages(admin, channel, messages)
  } catch (error) {
    ok = false
    console.error('[whapi-webhook] group messages failed:', error)
  }
  try {
    // Submission groups (module 018a) are not in `whatsapp_groups`, so
    // the write above counted them as unknown. A failure clears `ok` so
    // the delivery is not confirmed and Whapi redelivers it: both writes
    // are idempotent on (group, message id), so a replay is safe.
    const sg = await recordSubmissionGroupInbound(
      new SubmissionGroupStore(admin),
      channel,
      messages,
      {
        caseSla: caseSlaInboundHook(admin),
        // A customer's document or photo is only collected here; the
        // route files it after the 1:1 messages (178).
        customerDocument: (doc) => {
          filer.hook(doc)
          intake.document(doc)
        },
        // Intake queues first (sync); the brain sink is awaited here, inside
        // the webhook's after(), and never rejects (022b).
        customerText: async (m) => {
          intake.text(m)
          await recordGroupCustomerText(m)
        },
      },
    )
    if (sg.failed > 0) ok = false
  } catch (error) {
    ok = false
    console.error('[whapi-webhook] submission group messages failed:', error)
  }
  try {
    // A 1:1 receipt matches no group row (and a group id no `messages`
    // row), so every receipt goes to both writers.
    if (statuses.length > 0) await applyGroupStatuses(admin, channel, statuses)
  } catch (error) {
    console.error('[whapi-webhook] group statuses failed:', error)
  }
  await applyWhapiGroupEvents(config, events)
  return ok
}

/**
 * The `groups` events of one callback. Not queued: they carry no id to
 * record them by. Never throws.
 */
async function applyWhapiGroupEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  events: WhapiGroupEvent[],
): Promise<void> {
  const channel: GroupChannel = {
    id: config.id,
    accountId: config.account_id,
    wabaId: config.waba_id ?? null,
  }
  const admin = supabaseAdmin()
  try {
    await applyGroupEvents(admin, channel, events)
  } catch (error) {
    console.error('[whapi-webhook] group events failed:', error)
  }
  try {
    // Leaves `ok` alone: the cron re-reads the group, so a lost event is no
    // reason to have Whapi redeliver the callback.
    const sgStore = new SubmissionGroupStore(admin)
    await recordSubmissionGroupMembership(sgStore, channel, events, (g, p) =>
      sgStore.staffNumberJoined(g, p),
    )
  } catch (error) {
    console.error('[whapi-webhook] submission group membership failed:', error)
  }
}

/**
 * Turn one authenticated Whapi callback's inbox traffic into CRM
 * state. The channel has already been checked (`channelMatches`).
 */
async function processWhapiWebhook(
  event: NormalizedWhapiWebhook,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  // Messages from a sender over the webhook rate limit (module 017a).
  overLimit: ReadonlySet<NormalizedInboundMessage>,
) {
  for (const status of event.statuses) {
    await handleStatusUpdate(status, config.account_id)
  }

  if (event.messages.length === 0) return

  const channel = inboundChannel('whapi', config)

  // Background work of each message (TypeSafe's watch), awaited once
  // the whole delivery is processed — still inside after().
  const later: Promise<unknown>[] = []
  for (const message of event.messages) {
    await processMessage(
      message,
      // Tenancy — drives every contact / conversation lookup and the
      // engines' active-row dispatch.
      config.account_id,
      // Audit / sender-of-record for inserts needing a NOT NULL
      // user_id FK. Always the admin who saved the channel.
      config.user_id,
      channel,
      later,
      // Over the limit: persisted to the inbox, but nothing answers it.
      overLimit.has(message) ? { fanOut: false } : undefined,
    )
  }
  await Promise.all(later)
}
