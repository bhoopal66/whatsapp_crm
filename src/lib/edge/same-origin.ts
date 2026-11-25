/**
 * Cross-site request refusal (CSRF) for the dashboard's internal API.
 *
 * Every /api route a signed-in person calls is authenticated by the
 * session cookie alone, which the browser attaches to any request to
 * this site, including one a hostile page makes. SameSite=Lax stops a
 * cross-SITE form post, but not one from a sibling subdomain (a
 * compromised marketing site, a Studio on studio.<domain>), and most
 * routes read a text/plain body as JSON. So the middleware refuses a
 * state-changing /api request that a browser says came from elsewhere:
 *
 *   - `Sec-Fetch-Site` (sent by every current browser) must be
 *     `same-origin` (or `none`: typed by the user);
 *   - without it, an `Origin` header, when present, must name this host
 *     (the Host or X-Forwarded-Host the proxy passed on);
 *   - a request with neither is not a browser's (webhooks, crons, the
 *     MCP server, curl) and goes through to the route's own check.
 *
 * Exempt: /api/v1 (API keys, never cookies) and /api/public (the web
 * form, which a customer's own site may post to). Pure: tested in
 * same-origin.test.ts, wired in src/middleware.ts.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PREFIXES = ['/api/v1/', '/api/public/'];

export interface OriginCheckInput {
  method: string;
  pathname: string;
  headers: { get(name: string): string | null };
}

/** The hosts this request may come from: what the proxy says it served. */
function servedHosts(headers: OriginCheckInput['headers']): Set<string> {
  const hosts = new Set<string>();
  for (const name of ['host', 'x-forwarded-host']) {
    const value = headers.get(name);
    if (!value) continue;
    for (const part of value.split(','))
      if (part.trim()) hosts.add(part.trim().toLowerCase());
  }
  return hosts;
}

/** True when the request must be refused as cross-site. */
export function isCrossSiteApiWrite(req: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const path = req.pathname;
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return false;

  const site = req.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = req.headers.get('origin');
  if (origin === null) return false;
  if (origin === 'null') return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  return !servedHosts(req.headers).has(host);
}
