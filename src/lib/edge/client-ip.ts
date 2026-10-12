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
  if (!name) return undefined;
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
