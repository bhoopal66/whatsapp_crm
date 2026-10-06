import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  extractWebhookSecret,
  secretsMatch,
} from '@/lib/whatsapp/whapi-webhook-auth'
import {
  normalizeWhapiWebhook,
  type RawWhapiWebhookPayload,
} from '@/lib/whatsapp/whapi-webhook'
import {
  handleStatusUpdate,
  processMessage,
} from '@/lib/whatsapp/inbound-pipeline'
import type { WhatsAppChannel } from '@/lib/whatsapp/channels'
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
          'Taamul Connect Whapi webhook endpoint is reachable. Append ?secret=<your webhook secret> to verify a channel.',
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
 * row is decrypted and compared in constant time. Installs have a few
 * Whapi rows per account (one per number since migration 060, each with
 * its own secret) and a handful of accounts at most; if that ever
 * stops being true, store a SHA-256 of the secret in an indexed column
 * and look it up directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findConfigByWebhookSecret(secret: string): Promise<any | null> {
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
    await handleStatusUpdate(status, config.account_id)
  }

  if (event.messages.length === 0) return

  // The pipeline is provider-agnostic and takes a resolved channel, so
  // shape the matched config row into one. Built by hand rather than
  // via `loadChannels` because this route runs on the service role with
  // the row already in hand — one fewer query on the hot inbound path.
  const channel: WhatsAppChannel = {
    id: config.id,
    accountId: config.account_id,
    provider: 'whapi',
    label: config.label ?? null,
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
    appSecret: null,
    isPrimary: config.is_primary !== false,
    // Per-channel opt-out for the inbound-media mirror (migration 039).
    mirrorInboundMedia: config.mirror_inbound_media !== false,
    status: config.status ?? 'connected',
  }

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
    )
  }
  await Promise.all(later)
}
