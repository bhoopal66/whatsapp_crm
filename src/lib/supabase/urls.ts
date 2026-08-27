/**
 * Which Supabase URL to use, and from where.
 *
 * A hosted Supabase project has exactly one URL and this distinction
 * never comes up. A self-hosted deployment has two, because the same
 * service is reachable by two different routes:
 *
 *   * The **browser** needs a publicly-resolvable HTTPS origin. It
 *     cannot use `http://localhost:8000` — `localhost` is the visitor's
 *     own machine, and an http:// call from an https:// page is blocked
 *     as mixed content regardless.
 *
 *   * The **server** is on the same host as the database and should
 *     talk to it directly. Sending its queries out to the public origin
 *     and back is a pointless round-trip, and it makes every server-side
 *     query depend on the reverse proxy or tunnel staying up — so a
 *     tunnel hiccup would take down the whole app rather than just the
 *     browser's live updates.
 *
 * Hence two variables. `SUPABASE_INTERNAL_URL` is optional and falls
 * back to the public one, so a hosted-Supabase install (and every
 * existing deployment) behaves exactly as before.
 */

/**
 * Browser-facing Supabase origin. Must be reachable from a visitor's
 * machine over HTTPS. This is the value baked into the client bundle.
 */
export function publicSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL!
}

/**
 * Server-facing Supabase origin. Prefers a direct, private address
 * (e.g. `http://localhost:8000` or a container hostname) and falls back
 * to the public one when unset.
 *
 * Safe to call from server code only — `SUPABASE_INTERNAL_URL` has no
 * `NEXT_PUBLIC_` prefix, so it is never exposed to the browser and
 * reads as `undefined` there.
 */
export function serverSupabaseUrl(): string {
  const internal = process.env.SUPABASE_INTERNAL_URL?.trim()
  return internal || process.env.NEXT_PUBLIC_SUPABASE_URL!
}

/**
 * The cookie (and localStorage) key holding the auth session.
 *
 * supabase-js derives this from the Supabase URL when it isn't given
 * one: `sb-${hostname.split('.')[0]}-auth-token`. That default is fine
 * for a hosted project, where browser and server share one URL — but
 * this deployment deliberately gives them two (see above), so the two
 * sides derive DIFFERENT keys and stop agreeing on where the session
 * lives:
 *
 *   browser  https://<tunnel-host>.trycloudflare.com/supabase
 *              -> sb-<tunnel-host>-auth-token
 *   server   http://localhost:8000
 *              -> sb-localhost-auth-token
 *
 * The browser writes its cookie under the first name; the middleware
 * looks for the second, finds nothing, treats the request as signed
 * out and bounces it back to /login. Sign-in itself succeeds — the
 * password is checked, `last_sign_in_at` updates — so the symptom is
 * an endless return to the login screen rather than a rejection.
 *
 * Pinning one explicit name fixes that, and drops the dependency on
 * the hostname entirely: a quick tunnel gets a new hostname on every
 * restart, which under the default would silently invalidate every
 * existing session.
 *
 * Changing this value logs everyone out once; it does not otherwise
 * affect the stored session.
 */
export const AUTH_COOKIE_NAME = 'sb-wacrm-auth-token'

/**
 * Re-point a server-built Supabase URL at the browser-facing origin.
 *
 * `storage.getPublicUrl()` composes its result from the base URL of the
 * client that made it. Server-side that client is built on
 * `serverSupabaseUrl()`, so a URL destined for an <img> or <audio> tag
 * comes back as `http://localhost:8000/storage/v1/object/public/...` —
 * unreachable from a visitor's machine, and blocked as mixed content
 * from an https:// page even if it resolved. Inbound media mirrored by
 * the webhook is exactly that case: the bytes land in the bucket
 * correctly and the attachment still renders as a broken image or a
 * player that will not start.
 *
 * Browser-side callers (avatar upload, outbound media) already build on
 * `publicSupabaseUrl()` and need no translation; this is a no-op for
 * them, and for any install where the two URLs are the same.
 */
export function toPublicSupabaseUrl(url: string): string {
  // Both getters are non-null-asserted for the configured case, but this
  // sits on the inbound-media path where the caller swallows throws into
  // a null URL — an unset variable would silently cost every attachment
  // its link. Degrade to the input instead.
  const stripSlash = (u: string | undefined) => (u ?? '').replace(/\/+$/, '')
  const internal = stripSlash(serverSupabaseUrl())
  const publicBase = stripSlash(publicSupabaseUrl())

  if (!url || !internal || !publicBase || internal === publicBase) return url
  return url.startsWith(internal) ? publicBase + url.slice(internal.length) : url
}
