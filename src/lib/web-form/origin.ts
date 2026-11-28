/**
 * Which sites may post to a workspace's public web form (migration 249,
 * docs/web-form.md). Pure; the route, the settings panel and the tests
 * share it. `web_form_origin_ok` (249, http allowed since 258) is the SQL twin of
 * `normalizeAllowedOrigin`: change one, change both.
 */

export const MAX_ALLOWED_ORIGINS = 20;

const ORIGIN_SHAPE =
  /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;

/**
 * An admin's line as the origin a browser sends ("https://www.x.com" or
 * "http://www.x.com"), or null when it is not one. A trailing slash is
 * forgiven; a path, query or credentials are not (a browser never sends
 * them in Origin, so such an entry could never match).
 */
export function normalizeAllowedOrigin(raw: string): string | null {
  let text = raw.trim().toLowerCase();
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (!text || text.length > 200) return null;
  return ORIGIN_SHAPE.test(text) ? text : null;
}

/** The settings textarea (one origin per line) → origins + the lines refused. */
export function parseAllowedOrigins(text: string): {
  origins: string[];
  invalid: string[];
} {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const origin = normalizeAllowedOrigin(line);
    if (!origin) invalid.push(line.trim());
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

/** `new URL(x).origin` or null. */
export function originOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin.toLowerCase();
  } catch {
    return null;
  }
}

export type OriginDecision =
  | {
      ok: true;
      /** Echo in Access-Control-Allow-Origin, or null for none. */
      cors: string | null;
    }
  | { ok: false };

/**
 * May a request with this Origin header submit?
 *
 *  - Our own origin (the hosted /f/ page): always, no CORS header.
 *  - A listed origin: yes, and it is echoed back for CORS.
 *  - No Origin header (a server-side post, an old browser): only while
 *    the list is empty. With a list, the admin asked for "these sites
 *    only", and every browser sends Origin on a cross-site POST.
 *  - Anything else: no.
 */
export function decideOrigin(input: {
  origin: string | null;
  selfOrigins: readonly string[];
  allowed: readonly string[];
}): OriginDecision {
  const origin = input.origin?.trim().toLowerCase() || null;
  if (!origin) {
    return input.allowed.length === 0
      ? { ok: true, cors: null }
      : { ok: false };
  }
  // `Origin: null` is a sandboxed frame or a file:// page: never trusted.
  if (origin === 'null') return { ok: false };
  if (input.selfOrigins.some((s) => s.toLowerCase() === origin)) {
    return { ok: true, cors: null };
  }
  if (input.allowed.includes(origin)) return { ok: true, cors: origin };
  return { ok: false };
}
