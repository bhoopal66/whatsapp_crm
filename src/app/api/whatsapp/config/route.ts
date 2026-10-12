import { pickActiveProfile } from '@/lib/auth/active-profile'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  WhapiError,
  describeChannelStatus,
  getChannelInfo,
  getChannelSettings,
  isOurWebhook,
  registerWebhook,
} from '@/lib/whatsapp/whapi-api'
import {
  buildWebhookUrl,
  generateWebhookSecret,
  redactWebhookUrl,
} from '@/lib/whatsapp/whapi-webhook-auth'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { nextHealth, syncPairedNumber } from '@/lib/whatsapp/channel-health'
import { serverSupabaseUrl } from '@/lib/supabase/urls'

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
  const { data: rows, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
  const data = pickActiveProfile(rows)
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * The Whapi row a request is about.
 *
 * Since migration 060 an account can hold several Whapi numbers, so
 * every handler takes an optional `config_id`. Without one it acts on
 * the account's first Whapi row (primary first, then oldest) — the
 * pre-060 behaviour, which is what an older client or a single-number
 * install still gets.
 */
async function findWhapiRow<T>(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  columns: string,
  configId: string | null,
): Promise<{ data: T | null; error: { message: string } | null }> {
  let query = supabase
    .from('whatsapp_config')
    .select(columns)
    .eq('account_id', accountId)
    // Whapi rows only: an account can also hold a Meta row.
    .eq('provider', 'whapi')
  query = configId
    ? query.eq('id', configId)
    : query
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
  const { data, error } = await query.limit(1).maybeSingle()
  return { data: (data as T | null) ?? null, error }
}

/**
 * If the account is left with channels but no primary — the primary
 * was just disconnected — promote the oldest remaining one, so the
 * fallback is a deliberate choice rather than whatever `primaryChannel`
 * happens to see first.
 */
async function ensurePrimary(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<void> {
  const { data: rows } = await supabase
    .from('whatsapp_config')
    .select('id, is_primary, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (!rows || rows.length === 0 || rows.some((r) => r.is_primary)) return
  await supabase
    .from('whatsapp_config')
    .update({ is_primary: true })
    .eq('id', rows[0].id)
    .eq('account_id', accountId)
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
      serverSupabaseUrl(),
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
export async function GET(request: Request) {
  try {
    // Admin+. This is the WhatsApp channel: reading it exposes the
    // connected number and channel state, and writing it re-points
    // where the business's messages come from and where inbound
    // callbacks are delivered. Settings -> WhatsApp is an admin-only
    // section, and the API behind it has to agree.
    try {
      await requireRole('admin')
    } catch (err) {
      return toErrorResponse(err)
    }

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

    const configId = new URL(request.url).searchParams.get('config_id')
    const { data: config, error: configError } = await findWhapiRow<{
      id: string
      phone_number_id: string
      waba_id: string | null
      label: string | null
      access_token: string
      status: string
      registered_at: string | null
    }>(
      supabase,
      accountId,
      'id, phone_number_id, waba_id, label, access_token, status, registered_at',
      configId,
    )

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
            'The stored channel token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or differs between environments. Paste the channel token again below and click Save — the number keeps its name, its people and its chats.',
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

    // The phone behind a channel can be re-paired to another handset;
    // keep the stored display number (read by the inbox and alerts) in
    // step with what Whapi reports. Best-effort, never throws.
    await syncPairedNumber(
      supabase,
      { id: config.id, accountId, wabaId: config.waba_id, label: config.label },
      channel.phone,
    )

    // Report which callback URL the channel currently points at, so a
    // stale tunnel URL is visible rather than silently swallowing every
    // inbound message — and which entries are NOT this CRM's. Those are
    // kept on purpose (registerWebhook never drops a third party's
    // hook), but each one receives every message on the number, so an
    // admin must be able to tell a forgotten debug bin from our own.
    let webhookHooks: Array<{ url: string; ours: boolean }> = []
    try {
      const settings = await getChannelSettings({ token })
      let ourUrl: string | null = null
      try {
        ourUrl = `${resolveOrigin(request)}/api/whatsapp/webhook`
      } catch {
        // No resolvable origin: flag nothing rather than everything.
      }
      webhookHooks = (settings.webhooks ?? [])
        .map((hook) => hook.url)
        .filter((url): url is string => Boolean(url))
        .map((url) => ({
          // Classified on the raw URL; only the display copy is redacted.
          url: redactWebhookUrl(url),
          ours: ourUrl ? isOurWebhook(url, ourUrl) : true,
        }))
    } catch {
      // Non-fatal — the channel probe above is what determines health.
    }

    return NextResponse.json({
      connected: channel.authorized,
      reason: channel.authorized ? undefined : 'channel_not_authorized',
      message: describeChannelStatus(channel.status),
      config_id: config.id,
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
        // `urls` is what the Settings screen reads today; `hooks` adds
        // whether each one is ours.
        urls: webhookHooks.map((hook) => hook.url),
        hooks: webhookHooks,
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
    // Admin+. This is the WhatsApp channel: reading it exposes the
    // connected number and channel state, and writing it re-points
    // where the business's messages come from and where inbound
    // callbacks are delivered. Settings -> WhatsApp is an admin-only
    // section, and the API behind it has to agree.
    try {
      await requireRole('admin')
    } catch (err) {
      return toErrorResponse(err)
    }

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
      config_id: rawConfigId,
      create: createNew,
      label: rawLabel,
    } = body as {
      token?: string
      channel_id?: string
      rotate_secret?: boolean
      /** Which Whapi number to re-save (migration 060). */
      config_id?: string
      /** Connect an ADDITIONAL Whapi number rather than re-save one. */
      create?: boolean
      /** Name for a newly connected number. Ignored on a re-save. */
      label?: string
    }
    const configId =
      typeof rawConfigId === 'string' && rawConfigId.trim()
        ? rawConfigId.trim()
        : null
    const label =
      typeof rawLabel === 'string' ? rawLabel.trim().slice(0, 60) : ''

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

    // Reject if another account already claimed this channel. Taamul Connect is
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

    // Which row this save writes. `create` always adds a new number;
    // otherwise it is the named row, or the account's first Whapi row
    // for a client that predates migration 060.
    let existing: {
      id: string
      verify_token: string | null
      waba_id: string | null
      status: string
    } | null = null
    if (!createNew) {
      const found = await findWhapiRow<{
        id: string
        verify_token: string | null
        waba_id: string | null
        status: string
      }>(
        supabase,
        accountId,
        'id, verify_token, waba_id, status',
        configId,
      )
      existing = found.data
      if (configId && !existing) {
        return NextResponse.json(
          { error: 'That WhatsApp number is not connected on this account.' },
          { status: 404 }
        )
      }
    }

    // The same channel twice on one account would give two rows the
    // same phone_number_id — the UNIQUE constraint rejects it, and even
    // if it didn't, inbound would match only one. Say which row has it.
    const { data: duplicate } = await supabase
      .from('whatsapp_config')
      .select('id, label, waba_id')
      .eq('account_id', accountId)
      .eq('phone_number_id', channelId)
      .maybeSingle()
    if (duplicate && duplicate.id !== existing?.id) {
      return NextResponse.json(
        {
          error: `This Whapi channel is already connected on this account as "${duplicate.label || duplicate.waba_id || channelId}". Open that number to update its token instead.`,
        },
        { status: 409 }
      )
    }

    // The same PHONE twice is the same collision wearing a different
    // channel id: the operator re-pasted a token under a mistyped id,
    // or linked one phone to two Whapi channels. Either way the second
    // row's webhook registration would replace the first's callback
    // (registerWebhook matches ours by path), and the first number
    // would silently stop receiving. The channel id is operator input;
    // the phone comes from Whapi itself, so it is the reliable key.
    // Checked across accounts too, on the service role, like `claimed`.
    if (channel.phone) {
      const { data: samePhone } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('id, account_id, label')
        .eq('provider', 'whapi')
        .eq('waba_id', channel.phone)
      const clash = (samePhone ?? []).find(
        (r: { id: string }) => r.id !== existing?.id,
      ) as { id: string; account_id: string; label: string | null } | undefined
      if (clash) {
        return NextResponse.json(
          {
            error:
              clash.account_id === accountId
                ? `The phone ${channel.phone} is already connected on this account as "${clash.label || channel.phone}". Each WhatsApp number can be connected once — open that number to update its token instead.`
                : `The phone ${channel.phone} is already connected to another account on this instance. Each WhatsApp number can only be connected once.`,
          },
          { status: 409 }
        )
      }
    }

    // Reuse the existing webhook secret when there is one, so a
    // re-save (e.g. after rotating the Whapi token) doesn't
    // invalidate a callback URL that is already working. Rotation is
    // explicit via `rotate_secret`. A new number always gets its own
    // secret — it is what tells the webhook which number a callback
    // is for.

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

    // "Connected" means the channel is reachable and paired; inbound
    // readiness is `registered_at`. A re-save derives it by the health
    // monitor's rule (channel-health.ts): AUTH is up, QR and ERROR are
    // down, and LAUNCH/INIT — a channel starting or syncing, which a
    // save can easily catch — keep the number's current status. Writing
    // 'disconnected' for those refused Compass sends until the next
    // sweep, which then announced a "connected again" nobody needed. A
    // new number has no status to keep.
    const now = new Date().toISOString()
    const status = existing
      ? nextHealth(existing.status, { ok: true, status: channel.status }).status
      : channel.authorized
        ? 'connected'
        : 'disconnected'

    const baseRow = {
      phone_number_id: channelId,
      // Display only — Whapi has no WABA. Holding the connected number
      // here keeps the Settings page useful when the channel is asleep.
      // A logged-out (QR) channel reports no number, and a token re-save
      // then must not erase the one we know: it names the number in
      // alerts and keys the same-phone guard above. Once a phone is
      // paired again, `syncPairedNumber` (health sweep, GET) catches up.
      waba_id: channel.phone ?? existing?.waba_id ?? null,
      access_token: encryptedToken,
      verify_token: encryptedSecret,
      status,
      registered_at: registeredAt,
      last_registration_error: registrationError,
      updated_at: now,
    }

    let savedId: string | null = existing?.id ?? null
    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({
          ...baseRow,
          // Stamped on a real transition only: a re-save of a number
          // that was already up does not make it "connected since now".
          ...(status === 'connected' && existing.status !== 'connected'
            ? { connected_at: now }
            : {}),
        })
        .eq('account_id', accountId)
        // This row only: the account may hold other Whapi numbers and a
        // Meta one, and none of them should get these credentials.
        .eq('id', existing.id)

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
      // `is_primary` defaults to TRUE, but migration 046 enforces at
      // most one primary per account with a partial unique index — so a
      // straight insert would fail when a Meta number is already
      // connected and holds the flag. First channel in wins it.
      const { count: siblingCount } = await supabase
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)

      const newRow = {
        account_id: accountId,
        user_id: user.id,
        provider: 'whapi',
        // Operator-facing name for the routing selector and the
        // Numbers screen. Set only on connect so a name an admin
        // edited is never clobbered by a token re-save.
        label: label || (channel.phone ? `WhatsApp ${channel.phone}` : 'WhatsApp (Whapi)'),
        is_primary: (siblingCount ?? 0) === 0,
        ...baseRow,
        connected_at: status === 'connected' ? now : null,
      }
      let { data: inserted, error: insertError } = await supabase
        .from('whatsapp_config')
        .insert(newRow)
        .select('id')
        .single()
      // Two first-connects at once both counted zero siblings and both
      // claimed the default; the one-primary index (046) rejects the
      // second. It is still a perfectly good number — save it as a
      // non-default one rather than losing it after Whapi already
      // points at its callback secret.
      if (
        insertError?.code === '23505' &&
        insertError.message.includes('idx_whatsapp_config_one_primary')
      ) {
        ;({ data: inserted, error: insertError } = await supabase
          .from('whatsapp_config')
          .insert({ ...newRow, is_primary: false })
          .select('id')
          .single())
      }
      savedId = (inserted?.id as string | undefined) ?? null

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
      config_id: savedId,
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
export async function DELETE(request: Request) {
  try {
    // Admin+. This is the WhatsApp channel: reading it exposes the
    // connected number and channel state, and writing it re-points
    // where the business's messages come from and where inbound
    // callbacks are delivered. Settings -> WhatsApp is an admin-only
    // section, and the API behind it has to agree.
    try {
      await requireRole('admin')
    } catch (err) {
      return toErrorResponse(err)
    }

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

    // One number at a time (migration 060): the named row, or the
    // first Whapi row for an older client. The Meta number, the other
    // Whapi numbers, and routes pointing at them are left alone; routes
    // and allocations for THIS number cascade, and its chat history
    // stays (conversations/messages.channel_id go NULL).
    const configId = new URL(request.url).searchParams.get('config_id')
    const { data: target } = await findWhapiRow<{ id: string }>(
      supabase,
      accountId,
      'id',
      configId,
    )
    if (!target) {
      return NextResponse.json({ success: true })
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)
      .eq('id', target.id)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    await ensurePrimary(supabase, accountId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
