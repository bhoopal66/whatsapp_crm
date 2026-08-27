import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/whapi-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import {
  extractWebhookSecret,
  secretsMatch,
} from '@/lib/whatsapp/whapi-webhook-auth'
import {
  normalizeWhapiWebhook,
  type NormalizedInboundMessage,
  type NormalizedStatus,
  type RawWhapiWebhookPayload,
} from '@/lib/whatsapp/whapi-webhook'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { serverSupabaseUrl } from '@/lib/supabase/urls'

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
          'wacrm Whapi webhook endpoint is reachable. Append ?secret=<your webhook secret> to verify a channel.',
      },
      { status: 200 },
    )
  }

  const config = await findConfigByWebhookSecret(secret)
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
  const config = secret ? await findConfigByWebhookSecret(secret) : null

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
    try {
      await processWhapiWebhook(payload, config)
    } catch (error) {
      console.error('[whapi-webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/**
 * Find the `whatsapp_config` row whose webhook secret matches.
 *
 * Secrets are stored encrypted, so this cannot be a WHERE clause — every
 * row is decrypted and compared in constant time. Installs have one
 * config row per account and a handful of accounts at most; if that ever
 * stops being true, store a SHA-256 of the secret in an indexed column
 * and look it up directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findConfigByWebhookSecret(secret: string): Promise<any | null> {
  const { data: configs, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')

  if (error || !configs) {
    console.error('[whapi-webhook] could not load configs:', error)
    return null
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
    if (secretsMatch(secret, stored)) return config
  }

  return null
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
    .eq('account_id', config.account_id)

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
 * Turn one authenticated Whapi callback into CRM state.
 *
 * The heavy lifting — contact dedup, conversation resolution, Flows,
 * automations, AI auto-reply, public webhook fan-out — is all
 * provider-agnostic and lives below. This function's only job is to
 * normalise the payload and dispatch.
 */
async function processWhapiWebhook(
  payload: RawWhapiWebhookPayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
) {
  const event = normalizeWhapiWebhook(payload)

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
      return
    }
  }

  for (const status of event.statuses) {
    await handleStatusUpdate(status)
  }

  if (event.messages.length === 0) return

  const channelToken = decrypt(config.access_token)

  for (const message of event.messages) {
    await processMessage(
      message,
      // Tenancy — drives every contact / conversation lookup and the
      // engines' active-row dispatch.
      config.account_id,
      // Audit / sender-of-record for inserts needing a NOT NULL
      // user_id FK. Always the admin who saved the channel.
      config.user_id,
      channelToken,
      // Per-account opt-out for the inbound-media mirror (migration 039).
      config.mirror_inbound_media !== false,
    )
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once the message
// has been delivered or read, a later "failed" status event is a bug in
// the gateway's pipeline or a spoof attempt and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: NormalizedStatus) {
  // 1) Mirror onto messages. The normaliser has already mapped Whapi's
  //    vocabulary onto the values the CHECK constraint on
  //    messages.status accepts (and dropped the ones with no CRM
  //    meaning), so this writes straight through. No `.select()`:
  //    message_id is NOT unique (migration 009 — ids repeat across
  //    numbers), so this updates 0..N rows and must not assume one.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.messageId)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.messageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.messageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.messageId,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a WhatsApp message id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install, or one
 * sent from the operator's phone before the channel was connected).
 */
async function lookupInternalIdByWhatsAppId(
  whatsappMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', whatsappMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[whapi-webhook] lookupInternalIdByWhatsAppId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: NormalizedInboundMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.targetMessageId) return

  const targetInternalId = await lookupInternalIdByWhatsAppId(
    reaction.targetMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[whapi-webhook] reaction target message not found; skipping',
      reaction.targetMessageId
    )
    return
  }

  // Empty emoji = the customer removed their reaction.
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[whapi-webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[whapi-webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: NormalizedInboundMessage,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp channel; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  // The Whapi channel token — needed to pull media bytes for mirroring.
  channelToken: string,
  // Per-account opt-out for the inbound-media mirror (migration 039).
  // See parseMessageContent for what it turns off.
  mirrorMedia: boolean
) {
  const senderPhone = normalizePhone(message.from)
  // Whapi carries the sender's WhatsApp display name on the message
  // itself (`from_name`), so there's no separate contacts array to zip
  // against as there was with Meta. Fall back to the number when the
  // sender has no public display name.
  const contactName = message.fromName || senderPhone

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(
      message,
      channelToken,
      mirrorMedia ? { accountId } : null
    )

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.contextMessageId) {
    replyToInternalId = await lookupInternalIdByWhatsAppId(
      message.contextMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[whapi-webhook] reply context parent not found:',
        message.contextMessageId
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // The normaliser already narrowed Whapi's much larger type vocabulary
  // down to this set plus `sticker` and `contacts`, which have no column
  // value of their own and map to the closest allowed one.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are WebP images
      : 'text'    // shared contact cards, anything unforeseen

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: message.id,
        status: 'delivered',
        created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentText || `[${message.type}]`,
    }
  )

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(supabaseAdmin(), conversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}
/**
 * Turn a normalised inbound message into the columns the `messages`
 * row needs: display text, a durable media URL, the MIME type, and the
 * tapped-option id for interactive replies.
 *
 * ─── Where inbound media comes from under Whapi ───────────────────
 *
 * `registerWebhook` turns Whapi's auto-download on, so an attachment
 * arrives with a `link` already pointing at Whapi's file store. That
 * link is NOT durable — Whapi retains inbound files for roughly 30
 * days, exactly the same expiry problem Meta's media ids had (issue
 * #466), and an attachment that silently becomes "Photo unavailable" a
 * month later is a bad outcome for a CRM whose whole job is history.
 *
 * So the link is a starting point, not a destination: `mirrorInboundMedia`
 * copies the bytes into the account's `chat-media` bucket and we persist
 * that permanent URL instead. When auto-download hasn't populated a link
 * (a channel configured before this CRM registered its webhook), we fall
 * back to resolving the media id through `GET /media/{id}`.
 *
 * The mirror is strictly best-effort — it swallows its own failures and
 * returns null. A webhook that threw would have Whapi redeliver and
 * re-run everything downstream, which is far worse than an attachment
 * that expires.
 */
async function parseMessageContent(
  message: NormalizedInboundMessage,
  channelToken: string,
  // Tenancy + opt-out for the media mirror. Null disables mirroring
  // entirely, which is what the account-level toggle does.
  mirror: { accountId: string } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // Default shape — each branch overrides only what it cares about.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  // ---- Non-media types resolve without any network call ----------

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text }

    case 'location': {
      const loc = message.location
      if (!loc) return empty
      const locationText = [
        loc.name,
        loc.address,
        `${loc.latitude},${loc.longitude}`,
      ]
        .filter(Boolean)
        .join(' - ')
      return { ...empty, contentText: locationText }
    }

    case 'contacts':
      return { ...empty, contentText: message.text }

    case 'reaction':
      // Never reached in practice — processMessage short-circuits
      // reactions before calling here — but kept total so a future
      // caller can't fall through to the media path with no payload.
      return { ...empty, contentText: message.reaction?.emoji ?? null }

    case 'interactive':
      // The customer tapped a reply button or a list row on a message we
      // sent. Use the human-readable title as contentText so the inbox
      // bubble reads legibly ("Existing customer"), and keep the stable
      // id separately so Flows and the `interactive_reply` automation
      // trigger can route on it.
      return {
        ...empty,
        contentText:
          message.interactiveReplyTitle ??
          message.interactiveReplyId ??
          '[Interactive reply]',
        interactiveReplyId: message.interactiveReplyId,
      }
  }

  // ---- Media types: image / video / audio / document / sticker ----

  const media = message.media
  if (!media) {
    return { ...empty, contentText: message.text }
  }

  const mediaUrl = await resolveInboundMediaUrl(message, channelToken, mirror)

  return {
    ...empty,
    // A document with no caption still deserves a legible bubble, so
    // fall back to its filename.
    contentText: message.text ?? (message.type === 'document' ? media.filename : null),
    mediaUrl,
    mediaType: media.mimeType,
  }
}

/**
 * Produce the durable URL stored on `messages.media_url`, preferring a
 * copy in our own bucket and degrading gracefully at every step.
 *
 * Returns null only when the bytes are genuinely unreachable — the
 * message still persists, just without an attachment, which is what the
 * inbox renders as a missing-media bubble.
 */
async function resolveInboundMediaUrl(
  message: NormalizedInboundMessage,
  channelToken: string,
  mirror: { accountId: string } | null
): Promise<string | null> {
  const media = message.media
  if (!media) return null

  let downloadUrl = media.link
  let mimeType = media.mimeType
  let fileSize = media.fileSize

  // No auto-downloaded link — ask Whapi to resolve the media id.
  if (!downloadUrl) {
    if (!media.id) return null
    try {
      const info = await getMediaUrl({ token: channelToken, mediaId: media.id })
      downloadUrl = info.url
      mimeType = mimeType ?? info.mimeType
      fileSize = fileSize ?? info.fileSize
    } catch (error) {
      console.error(
        `[whapi-webhook] could not resolve media ${media.id}:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  if (mirror) {
    try {
      const mirrored = await mirrorInboundMedia({
        storage: supabaseAdmin().storage,
        accountId: mirror.accountId,
        mediaId: media.id ?? message.id,
        downloadUrl,
        accessToken: channelToken,
        mimeType: mimeType ?? undefined,
        fileSize,
        fileName: media.filename,
        messageTimestamp: message.timestamp,
      })
      if (mirrored) return mirrored
    } catch (error) {
      // mirrorInboundMedia already swallows its own failures; this is
      // belt-and-braces so an unexpected throw can't lose the message.
      console.error(
        '[whapi-webhook] media mirror threw unexpectedly:',
        error instanceof Error ? error.message : error
      )
    }
  }

  // Mirroring off or failed: fall back to Whapi's own link. It works
  // today and expires in ~30 days, which beats an empty bubble now.
  return downloadUrl
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
