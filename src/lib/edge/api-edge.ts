/**
 * What the middleware does at the edge of the dashboard's `/api` routes
 * (package 033d): a request id on every response, an in-memory rate
 * limit per person and per client IP, and an optional one-line JSON
 * access log. Page loads are not limited or logged.
 *
 * Edge-safe on purpose: `src/middleware.ts` runs in the Edge runtime
 * (no `runtime` export), where `node:net` does not exist, so this file
 * imports no Node built-in. That is why it carries its own IP keyer
 * (`apiIpKey`) instead of `ip.ts`'s; the tests hold the two to the same
 * answers.
 *
 * The limiter is per instance, not shared: an in-process fixed window,
 * so the middleware never makes a database round trip on an API
 * request. With several replicas each one counts on its own, so the
 * effective limit is the configured one times the replica count. The
 * limits that must hold across instances (sign-in lockout, webhook
 * screening, the public API's per-key limit) stay in Postgres
 * (migration 084). docs/security.md, "API rate limit".
 */

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The id a response carries as `X-Request-Id`: the caller's own when it
 * is a short safe token (it lands in logs and headers, so nothing that
 * could inject or bloat them), else a fresh UUID.
 */
export function requestIdFor(
  inbound: string | null | undefined,
  generate: () => string = () => crypto.randomUUID()
): string {
  return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound)
    ? inbound
    : generate();
}

const HEALTH_PATHS = new Set(['/api/healthz', '/api/readyz', '/api/metrics']);

/**
 * `/api` routes the edge limiter never answers 429 on:
 *  - every inbound webhook (a `webhook` path segment, the PBX gateway
 *    and the Yeastar event intake): webhooks never answer 429
 *    (docs/agents/edge-security.md), they are screened per sender instead;
 *  - `/api/v1/*`, which has its own per-key limiter;
 *  - the `x-cron-secret` endpoints (last segment `cron`), pinged by one
 *    scheduler IP;
 *  - `/api/healthz`, `/api/readyz` and `/api/metrics`, probed by the
 *    orchestrator and the scraper.
 */
export function isApiLimitExempt(pathname: string): boolean {
  if (HEALTH_PATHS.has(pathname)) return true;
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) return true;
  if (pathname === '/api/pbx/gateway/events') return true;
  if (pathname.startsWith('/api/pbx/yeastar/events/')) return true;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.includes('webhook')) return true;
  return segments[segments.length - 1] === 'cron';
}

export interface ApiLimits {
  /** Requests per window for one signed-in person; 0 = off. */
  perUser: number;
  /** Requests per window for one client IP (IPv6 by /64); 0 = off. */
  perIp: number;
  windowMs: number;
}

export const API_LIMIT_DEFAULTS: ApiLimits = {
  perUser: 600,
  perIp: 1200,
  windowMs: 60_000,
};

/**
 * `EDGE_API_LIMIT_PER_USER` / `EDGE_API_LIMIT_PER_IP`: requests per
 * minute. A non-negative integer overrides the default (0 turns that
 * limit off); anything else keeps the default.
 */
export function apiLimitsFrom(
  env: Record<string, string | undefined>
): ApiLimits {
  return {
    perUser: limitOr(env.EDGE_API_LIMIT_PER_USER, API_LIMIT_DEFAULTS.perUser),
    perIp: limitOr(env.EDGE_API_LIMIT_PER_IP, API_LIMIT_DEFAULTS.perIp),
    windowMs: API_LIMIT_DEFAULTS.windowMs,
  };
}

function limitOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

export interface LimitDecision {
  allowed: boolean;
  /** Whole seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in memory, bounded to `maxKeys` entries. A key
 * starting a new window is re-inserted, so the map stays ordered by
 * window start and the front is always the oldest window: at capacity
 * the oldest goes first, expired or not. Evicting a live window only
 * forgives that key (fails open), never refuses anyone.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(private readonly maxKeys = 10_000) {}

  hit(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now()
  ): LimitDecision {
    const current = this.windows.get(key);
    if (current && now - current.start < windowMs) {
      if (current.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.start + windowMs - now) / 1000)
          ),
        };
      }
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.windows.delete(key);
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    this.windows.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Keys currently held — exposed for tests. */
  get size(): number {
    return this.windows.size;
  }
}

/**
 * The client-IP limit key, with `ip.ts`'s answers and no `node:net`:
 * IPv4-mapped IPv6 → the IPv4, zone id dropped, other IPv6 → its /64.
 * Anything that is not a valid IPv6 address is keyed as given.
 */
export function apiIpKey(ip: string | undefined): string {
  if (typeof ip !== 'string') return 'unknown';
  const raw = ip.trim().split('%')[0];
  const g = ipv6Groups(raw);
  if (!g) return raw;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/** The eight 16-bit groups of a valid IPv6 address, else null. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  if (!s.includes(':')) return null;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    if (!IPV4.test(v4[1])) return null;
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const h = halves[0] ? halves[0].split(':') : [];
  const t = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = [...h, ...t];
  if (!parts.every((p) => HEX_GROUP.test(p))) return null;
  if (halves.length === 1 ? parts.length !== 8 : parts.length > 7) return null;
  const fill = Array<string>(8 - parts.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

/**
 * The client IP as the access log shows it: never the whole address.
 * IPv4 → its /24, IPv6 → its /48, anything else → `other`.
 */
export function logIpPrefix(ip: string | undefined): string | null {
  if (typeof ip !== 'string' || ip.trim() === '') return null;
  const key = apiIpKey(ip);
  if (IPV4.test(key)) return `${key.split('.').slice(0, 3).join('.')}.0/24`;
  if (key.endsWith('::/64')) {
    return `${key.split(':').slice(0, 3).join(':')}::/48`;
  }
  return 'other';
}

/** Routes whose path segment after the prefix is a secret or capability. */
const TOKEN_PATH_PREFIXES = [
  '/api/pbx/yeastar/events/',
  '/api/public/web-form/',
  '/api/invitations/',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOGGED_PATH = 200;

/**
 * The path as the access log shows it: the token segment of a
 * token-bearing route, and any other segment longer than 32 characters
 * that is not a UUID, become `:redacted`; capped at 200 characters.
 * (The query string never reaches here: callers pass the pathname.)
 */
export function redactApiPath(pathname: string): string {
  const prefix = TOKEN_PATH_PREFIXES.find((p) => pathname.startsWith(p));
  const tokenIndex = prefix ? prefix.split('/').length - 1 : -1;
  const redacted = pathname
    .split('/')
    .map((segment, i) =>
      i === tokenIndex || (segment.length > 32 && !UUID.test(segment))
        ? ':redacted'
        : segment
    )
    .join('/');
  return redacted.length > MAX_LOGGED_PATH
    ? `${redacted.slice(0, MAX_LOGGED_PATH)}…`
    : redacted;
}

/** `EDGE_REQUEST_LOG=1` turns the access log on; off by default. */
export function isRequestLogOn(
  env: Record<string, string | undefined>
): boolean {
  return env.EDGE_REQUEST_LOG?.trim() === '1';
}

export interface ApiRequestLogEntry {
  time: Date;
  requestId: string;
  method: string;
  pathname: string;
  ip?: string;
  userId?: string;
}

/**
 * One JSON line for one `/api` request. Only these fields, by
 * construction: no headers, cookies, tokens, query string or body.
 */
export function apiRequestLogLine(entry: ApiRequestLogEntry): string {
  return JSON.stringify({
    time: entry.time.toISOString(),
    msg: 'api_request',
    request_id: entry.requestId,
    method: entry.method.slice(0, 16),
    path: redactApiPath(entry.pathname),
    ip: logIpPrefix(entry.ip),
    user_id: entry.userId ?? null,
  });
}
