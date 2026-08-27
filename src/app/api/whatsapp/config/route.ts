import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  WhapiError,
  describeChannelStatus,
  getChannelInfo,
  getChannelSettings,
  registerWebhook,
} from '@/lib/whatsapp/whapi-api'
import {
  buildWebhookUrl,
  generateWebhookSecret,
  redactWebhookUrl,
} from '@/lib/whatsapp/whapi-webhook-auth'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * WhatsApp connection settings, backed by Whapi.Cloud.
 *
 * ─── How the columns map ──────────────────────────────────────────
 *
 * `whatsapp_config` was designed around Meta's credential triple. The
 * table is reused rather than re-shaped, because each Whapi concept
 * lands cleanly on an existing column — including the UNIQUE and
 * encryption properties we need:
 *
 *   phone_number_id → Whapi **channel id**. Already UNIQUE, which is
 *                     exactly the "one channel, one account" guarantee
 *                     the inbound router depends on.
 *   access_token    → Whapi **channel token**, AES-256-GCM encrypted.
 *   verify_token    → the **webhook shared secret**, also encrypted.
 *                     Meta used this for the `hub.challenge` handshake;
 *                     Whapi has no handshake, so the column now carries
 *                     the secret that authenticates inbound callbacks.
 *   waba_id         → the connected **WhatsApp phone number**, for
 *                     display. Whapi has no WABA equivalent.
 *   registered_at   → when the webhook was last registered on the
 *                     channel (the Whapi analogue of Meta's /register).
 *
 * Migration 040 documents this on the table itself.
 */

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw.
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. Needed to detect a channel id
// already claimed by a *different* account — under RLS the user's own
// session can't see other accounts' rows, so the conflict would be
// invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Public origin of this deployment, used to build the callback URL we
 * hand to Whapi.
 *
 * `NEXT_PUBLIC_SITE_URL` wins when set, because the webhook URL is
 * written into someone else's system and has to be the canonical one —
 * a request-derived host is whatever the last proxy claimed, and a
 * wrong value here means silently receiving no messages.
 */
function resolveOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim()
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }

  throw new Error(
    'Could not determine this deployment’s public URL. Set NEXT_PUBLIC_SITE_URL.',
  )
}

/** Map a WhapiError onto a message an operator can actually act on. */
function explainWhapiError(err: unknown): string {
  if (err instanceof WhapiError) {
    if (err.isAuthError || err.isUnknownChannel) {
      // 404 is not a typo here — see WhapiError.isUnknownChannel.
      return 'Whapi did not recognise that channel token. Copy it again from your channel page at panel.whapi.cloud.'
    }
    if (err.isBillingError) {
      return 'Your Whapi subscription is inactive — the channel is suspended until billing is resolved.'
    }
    if (err.status === 503) {
      return `Could not reach Whapi: ${err.message}`
    }
    return err.message
  }
  return err instanceof Error ? err.message : 'Unknown Whapi error'
}

/**
 * GET /api/whatsapp/config
 *
 * Backs the "Test connection" button and the Settings page's status
 * banner. Returns 200 in all non-auth cases so the UI can render a
 * specific message rather than a 500.
 *
 * Response shape:
 *   { connected: true,  channel: {...}, webhook: {...} }
 *   { connected: false, reason: 'no_config' | 'token_corrupted' | ... }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, status, registered_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No Whapi channel connected yet. Paste your channel token below and click Save.',
        },
        { status: 200 }
      )
    }

    let token: string
    try {
      token = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored channel token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or differs between environments. Click "Reset" below, then re-save your token.',
        },
        { status: 200 }
      )
    }

    // Probe the channel. `wakeup: false` — a status check should not
    // start a channel the operator deliberately stopped.
    let channel
    try {
      channel = await getChannelInfo({ token, wakeup: false })
    } catch (err) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'whapi_api_error',
          message: explainWhapiError(err),
        },
        { status: 200 }
      )
    }

    // Report which callback URL the channel currently points at, so a
    // stale tunnel URL is visible rather than silently swallowing every
    // inbound message.
    let webhookUrls: string[] = []
    try {
      const settings = await getChannelSettings({ token })
      webhookUrls = (settings.webhooks ?? [])
        .map((hook) => hook.url)
        .filter((url): url is string => Boolean(url))
        .map(redactWebhookUrl)
    } catch {
      // Non-fatal — the channel probe above is what determines health.
    }

    return NextResponse.json({
      connected: channel.authorized,
      reason: channel.authorized ? undefined : 'channel_not_authorized',
      message: describeChannelStatus(channel.status),
      channel: {
        channel_id: config.phone_number_id,
        phone: channel.phone ?? config.waba_id,
        display_name: channel.displayName,
        status: channel.status,
        version: channel.version,
        uptime: channel.uptime,
      },
      webhook: {
        registered_at: config.registered_at,
        urls: webhookUrls,
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Connect (or re-connect) a Whapi channel:
 *
 *   1. verify the token against `GET /health`,
 *   2. make sure no other account has claimed the channel,
 *   3. mint (or reuse) the webhook shared secret,
 *   4. point the channel's callback at this deployment,
 *   5. persist everything encrypted.
 *
 * Step 4 is where Meta's two-call register/subscribe dance used to
 * live; with Whapi it is a single idempotent PATCH.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      token: rawToken,
      channel_id: rawChannelId,
      rotate_secret: rotateSecret,
    } = body as {
      token?: string
      channel_id?: string
      rotate_secret?: boolean
    }

    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!token) {
      return NextResponse.json(
        { error: 'A Whapi channel token is required.' },
        { status: 400 }
      )
    }

    // Verify the token BEFORE saving anything. A bad token saved as
    // "connected" is the single most confusing state to debug later.
    let channel
    try {
      channel = await getChannelInfo({ token })
    } catch (err) {
      return NextResponse.json(
        { error: explainWhapiError(err) },
        { status: 400 }
      )
    }

    // The channel id is not exposed by /health, so it comes from the
    // operator (it's printed on the channel page). When omitted, fall
    // back to the connected phone number, which is equally unique per
    // channel and satisfies the UNIQUE constraint the router relies on.
    const channelId =
      (typeof rawChannelId === 'string' && rawChannelId.trim()) ||
      channel.phone ||
      null

    if (!channelId) {
      return NextResponse.json(
        {
          error:
            'Could not determine the channel id. Pair a phone to the channel at panel.whapi.cloud, or enter the channel id shown on its page.',
        },
        { status: 400 }
      )
    }

    // Reject if another account already claimed this channel. wacrm is
    // single-tenant-per-channel: two accounts sharing one channel would
    // make the inbound router ambiguous and silently drop messages
    // (issue #136). The UNIQUE constraint enforces it at the DB level;
    // this check turns that into a readable error.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', channelId)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking channel ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This Whapi channel is already linked to another account on this instance. Each channel can only be connected once.',
        },
        { status: 409 }
      )
    }

    // Reuse the existing webhook secret when there is one, so a
    // re-save (e.g. after rotating the Whapi token) doesn't
    // invalidate a callback URL that is already working. Rotation is
    // explicit via `rotate_secret`.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, verify_token')
      .eq('account_id', accountId)
      .maybeSingle()

    let webhookSecret: string | null = null
    if (!rotateSecret && existing?.verify_token) {
      try {
        webhookSecret = decrypt(existing.verify_token)
      } catch {
        // Encrypted under a rotated key — mint a fresh one below.
        webhookSecret = null
      }
    }
    if (!webhookSecret) webhookSecret = generateWebhookSecret()

    // Encrypt before any of it is written.
    let encryptedToken: string
    let encryptedSecret: string
    try {
      encryptedToken = encrypt(token)
      encryptedSecret = encrypt(webhookSecret)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt the token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment.',
        },
        { status: 500 }
      )
    }

    // Point the channel at this deployment. A failure here is NOT
    // fatal: the credentials are valid and worth saving, and outbound
    // sending works without a webhook. Only inbound is affected, so we
    // record the reason and let the UI offer a retry.
    let registeredAt: string | null = null
    let registrationError: string | null = null
    let webhookUrl: string | null = null

    try {
      webhookUrl = buildWebhookUrl(resolveOrigin(request), webhookSecret)
      await registerWebhook({ token, webhookUrl })
      registeredAt = new Date().toISOString()
    } catch (err) {
      registrationError = explainWhapiError(err)
      console.error('[whatsapp/config] webhook registration failed:', registrationError)
    }

    const baseRow = {
      phone_number_id: channelId,
      // Display only — Whapi has no WABA. Holding the connected number
      // here keeps the Settings page useful when the channel is asleep.
      waba_id: channel.phone,
      access_token: encryptedToken,
      verify_token: encryptedSecret,
      // The channel is reachable and the token is good; that is what
      // "connected" means here. Inbound readiness is `registered_at`.
      status: channel.authorized ? 'connected' : 'disconnected',
      connected_at: channel.authorized ? new Date().toISOString() : null,
      registered_at: registeredAt,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // `account_id` is the tenancy key (NOT NULL post-017, UNIQUE so
      // duplicates trip the constraint up front); `user_id` is the
      // audit column identifying which member saved the config.
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({
      success: !registrationError && channel.authorized,
      saved: true,
      registered: registeredAt != null,
      registration_error: registrationError,
      // Redacted — the raw secret is never echoed back to the browser.
      webhook_url: webhookUrl ? redactWebhookUrl(webhookUrl) : null,
      channel: {
        channel_id: channelId,
        phone: channel.phone,
        display_name: channel.displayName,
        status: channel.status,
      },
      message: describeChannelStatus(channel.status),
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the account's channel configuration. Backs the "Reset"
 * button — the recovery path for a token encrypted under a since-
 * rotated ENCRYPTION_KEY.
 *
 * The channel's webhook on Whapi's side is deliberately left alone: we
 * may no longer hold a usable token to unregister it with, and any
 * callback that does arrive is rejected by the secret check anyway.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
