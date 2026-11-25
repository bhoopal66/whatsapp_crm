/**
 * The client IP the webhook IP limit keys on, read from the one header
 * the deployment's own proxy sets — configured, never guessed:
 *
 *   EDGE_CLIENT_IP_HEADER    `cf-connecting-ip` (behind Cloudflare),
 *                            `x-real-ip`, or `x-forwarded-for`.
 *   EDGE_TRUSTED_PROXY_HOPS  x-forwarded-for only: how many proxies we
 *                            run in front of the app (default 1). The
 *                            entry that many hops from the right is the
 *                            client; everything left of it was written by
 *                            the client and is never trusted.
 *
 * Unset (or the header missing) → undefined, which the edge library keys
 * as one shared `'unknown'` bucket rather than trusting a spoofable value.
 */
export function clientIp(
  headers: Pick<Headers, 'get'>,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const name = env.EDGE_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!name) {
    warnUnsetOnce(env);
    return undefined;
  }
  const raw = headers.get(name);
  if (!raw) return undefined;
  if (name !== 'x-forwarded-for') return raw.trim() || undefined;

  const hops = Number(env.EDGE_TRUSTED_PROXY_HOPS ?? '1');
  const trusted = Number.isInteger(hops) && hops >= 1 ? hops : 1;
  const entries = raw.split(',').map((s) => s.trim());
  // Fewer entries than proxies: the request did not come through them all.
  const i = entries.length - trusted;
  return i >= 0 ? entries[i] || undefined : undefined;
}

let warned = false;

/**
 * A production server without EDGE_CLIENT_IP_HEADER keys every sign-in
 * and webhook limit on one shared bucket (docs/security.md, "Client
 * IP"): said once per process, loudly, so it is not discovered after an
 * attack.
 */
function warnUnsetOnce(env: Record<string, string | undefined>): void {
  if (warned || env.NODE_ENV !== 'production') return;
  warned = true;
  console.warn(
    '[edge] EDGE_CLIENT_IP_HEADER is not set: per-IP sign-in lockouts and webhook limits cannot tell callers apart. Set it to the header your proxy writes (cf-connecting-ip behind Cloudflare). docs/security.md'
  );
}

/** Tests only. */
export function resetClientIpWarning(): void {
  warned = false;
}
