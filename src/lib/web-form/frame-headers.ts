/**
 * Who may put the hosted web form (`/f/<token>`) in an <iframe>
 * (docs/web-form.md, "Embedding"). Pure; the middleware and the tests
 * share it.
 *
 * Every other route keeps the global `X-Frame-Options: DENY` from
 * next.config.ts and the middleware's CSP with `frame-ancestors 'none'`.
 * next.config.ts leaves `/f/*` out of X-Frame-Options, and the
 * middleware sends what this builds instead, per request, from the
 * form's own `allowed_origins` (the same list that gates posting).
 *
 * Why these exact headers:
 *  - `X-Frame-Options` has no allow-list (ALLOW-FROM is dead and named
 *    one origin at most), so a form that may be framed cannot send it:
 *    any XFO DENY on the response blocks framing whatever the CSP says.
 *    It is therefore dropped only when the list is non-empty, and the
 *    allow-list is carried by an ENFORCED
 *    `Content-Security-Policy` whose frame-ancestors lists <origins>
 *    (the request's whole policy with that one directive replaced; under
 *    CSP_MODE=report-only, the frame rule alone).
 *  - With no usable origin (empty list, unknown or switched-off token,
 *    lookup error) the answer is `frame-ancestors 'none'` plus
 *    `X-Frame-Options: DENY`, as strict as every other page.
 *  - Under CSP_MODE=report-only the policy is sent Report-Only on /f/,
 *    with its `frame-ancestors` restated to match the enforced one, so
 *    an allowed embed does not log a report for every page view.
 *
 * Only what `normalizeAllowedOrigin` accepts (https, host and optional
 * port, nothing else) becomes a source: never `*`, a bare scheme, a
 * path, a quote, a space or a `;` that could start another directive.
 * At most MAX_ALLOWED_ORIGINS sources, the same cap as the settings.
 */

import { MAX_ALLOWED_ORIGINS, normalizeAllowedOrigin } from './origin';

export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * The form token of an address whose frame headers are the form's own:
 * the hosted page `/f/<token>` and the route it posts to,
 * `/api/public/web-form/<token>`. The post answers with a 303 back to the
 * page (or an error), and Chrome applies X-Frame-Options / frame-ancestors
 * to that response inside the iframe too, so it must carry the same
 * allow-list as the page or an embedded submit goes blank. Anything else
 * (another path, a deeper path) is null: not framable.
 */
export function webFormFramePathToken(pathname: string): string | null {
  return (
    pathname.match(/^\/(?:f|api\/public\/web-form)\/([^/]+)\/?$/)?.[1] ?? null
  );
}

/** The allowed origins as frame-ancestors sources: normalised, unique, capped. */
export function frameAncestorSources(
  allowedOrigins: readonly unknown[] | null | undefined
): string[] {
  if (!Array.isArray(allowedOrigins)) return [];
  const out: string[] = [];
  for (const raw of allowedOrigins) {
    if (out.length >= MAX_ALLOWED_ORIGINS) break;
    if (typeof raw !== 'string') continue;
    const origin = normalizeAllowedOrigin(raw);
    // Belt and braces: the normaliser's shape already excludes these.
    if (!origin || /[\s;,'"*]/.test(origin)) continue;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** `frame-ancestors …` for these origins, or `'none'` when there are none. */
export function frameAncestorsDirective(
  allowedOrigins: readonly unknown[] | null | undefined
): string {
  const sources = frameAncestorSources(allowedOrigins);
  return sources.length === 0
    ? FRAME_ANCESTORS_NONE
    : `frame-ancestors ${sources.join(' ')}`;
}

/** `csp` with its frame-ancestors directive replaced (or appended). */
export function withFrameAncestors(csp: string, directive: string): string {
  const parts = csp
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  let replaced = false;
  const next = parts.map((p) => {
    if (/^frame-ancestors(\s|$)/i.test(p)) {
      replaced = true;
      return directive;
    }
    return p;
  });
  if (!replaced) next.push(directive);
  return next.join('; ');
}

/**
 * The frame headers for one `/f/<token>` response.
 *
 * `enforcedCsp` is this request's whole policy (src/lib/csp.ts) when it
 * is enforced: it goes out as the one `Content-Security-Policy`, its
 * frame-ancestors replaced by the form's own. Two enforced policies on
 * one response would both apply, so the frame rule cannot be a second
 * header.
 *
 * `reportOnlyCsp` is the policy under CSP_MODE=report-only: the enforced
 * header is then the frame rule alone, and the policy is returned
 * Report-Only with the same frame-ancestors.
 */
export function frameHeadersFor(
  allowedOrigins: readonly unknown[] | null | undefined,
  opts: { reportOnlyCsp?: string; enforcedCsp?: string } = {}
): Record<string, string> {
  const directive = frameAncestorsDirective(allowedOrigins);
  const headers: Record<string, string> = {
    'Content-Security-Policy': opts.enforcedCsp
      ? withFrameAncestors(opts.enforcedCsp, directive)
      : directive,
  };
  if (directive === FRAME_ANCESTORS_NONE) headers['X-Frame-Options'] = 'DENY';
  if (opts.reportOnlyCsp && !opts.enforcedCsp) {
    headers['Content-Security-Policy-Report-Only'] = withFrameAncestors(
      opts.reportOnlyCsp,
      directive
    );
  }
  return headers;
}
