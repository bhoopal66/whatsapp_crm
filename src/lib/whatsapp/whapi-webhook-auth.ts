/**
 * Inbound webhook authentication for Whapi callbacks.
 *
 * ─── Why this replaced HMAC ───────────────────────────────────────
 *
 * Meta signed every webhook POST with `X-Hub-Signature-256`, an
 * HMAC-SHA256 of the raw body keyed on the app secret. Whapi signs
 * nothing and offers no way to attach a custom header to a callback —
 * the only part of the request we control is the URL itself.
 *
 * So the shared secret lives in the webhook URL:
 *
 *     https://crm.example.com/api/whatsapp/webhook?secret=<64-hex>
 *
 * The secret is generated per channel when the operator saves their
 * Whapi settings, stored AES-256-GCM-encrypted in
 * `whatsapp_config.verify_token`, and written into the channel's
 * callback URL via `PATCH /settings`.
 *
 * ─── What this does and does not buy ──────────────────────────────
 *
 * It authenticates the *caller*: only someone holding the secret can
 * inject events. That is the property that matters — without it,
 * anyone who guessed the URL could forge inbound messages, fire
 * automations, and drive AI replies on someone else's account.
 *
 * It does NOT authenticate the *payload*: unlike an HMAC, a secret in
 * a URL cannot prove the body wasn't altered in transit. TLS covers
 * that on the wire. The residual exposure is that URLs are more prone
 * to landing in logs than headers are, so the secret is treated as a
 * rotatable credential: regenerating it in Settings re-registers the
 * channel and instantly invalidates the old URL.
 *
 * The secret doubles as the tenancy routing key. Whapi's `channel_id`
 * is also in the payload, but that is attacker-controlled data; the
 * secret is not, so the config row is resolved from the secret and the
 * channel id is only cross-checked afterwards.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'

/** Query parameter carrying the shared secret on the callback URL. */
export const WEBHOOK_SECRET_PARAM = 'secret'

/** Bytes of entropy in a generated webhook secret (→ 64 hex chars). */
const SECRET_BYTES = 32

/** Mint a fresh webhook secret. Called when a channel is first saved, and on rotation. */
export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex')
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * The values are hashed to a fixed 32 bytes first. `timingSafeEqual`
 * throws on a length mismatch, and that throw is itself an oracle for
 * the secret's length — hashing removes the length signal entirely and
 * lets one code path handle every input.
 */
export function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Pull the shared secret off an inbound callback request.
 *
 * The query string is the documented location, but a header is also
 * accepted: an operator fronting this deployment with a reverse proxy
 * can strip the query parameter out of access logs and re-present the
 * secret as `X-Whapi-Secret` instead.
 */
export function extractWebhookSecret(request: Request): string | null {
  const header = request.headers.get('x-whapi-secret')
  if (header) return header.trim()

  try {
    const url = new URL(request.url)
    const value = url.searchParams.get(WEBHOOK_SECRET_PARAM)
    return value ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * Build the callback URL registered with a Whapi channel.
 *
 * Whapi refuses to deliver to anything but HTTPS, so this rejects a
 * plaintext origin up front with an actionable message rather than
 * letting `PATCH /settings` fail opaquely later.
 */
export function buildWebhookUrl(origin: string, secret: string): string {
  const base = origin.replace(/\/+$/, '')

  if (!/^https:\/\//i.test(base)) {
    throw new Error(
      `Whapi only delivers webhooks over HTTPS, but this deployment's origin is "${base}". ` +
        'Set NEXT_PUBLIC_SITE_URL to an HTTPS URL — a domain with a certificate, ' +
        'or a tunnel such as Cloudflare Tunnel or ngrok.',
    )
  }

  const url = new URL(`${base}/api/whatsapp/webhook`)
  url.searchParams.set(WEBHOOK_SECRET_PARAM, secret)
  return url.toString()
}

/**
 * Redact the secret from a webhook URL for display or logging.
 * `…?secret=abcd…` → `…?secret=abcd****`.
 */
export function redactWebhookUrl(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl)
    const secret = url.searchParams.get(WEBHOOK_SECRET_PARAM)
    if (secret) {
      url.searchParams.set(WEBHOOK_SECRET_PARAM, `${secret.slice(0, 4)}****`)
    }
    return url.toString()
  } catch {
    return webhookUrl
  }
}
