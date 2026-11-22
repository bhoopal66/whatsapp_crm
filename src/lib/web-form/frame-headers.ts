/**
 * Who may put the hosted web form (`/f/<token>`) in an <iframe>
 * (docs/web-form.md, "Embedding"). Pure; the middleware and the tests
 * share it.
 *
 * Every other route keeps the global `X-Frame-Options: DENY` and the
 * Report-Only CSP's `frame-ancestors 'none'` from next.config.ts.
 * next.config.ts leaves `/f/*` out of those two headers, and the
 * middleware sends what this builds instead, per request, from the
 * form's own `allowed_origins` (the same list that gates posting).
 *
 * Why these exact headers:
 *  - `X-Frame-Options` has no allow-list (ALLOW-FROM is dead and named
 *    one origin at most), so a form that may be framed cannot send it:
 *    any XFO DENY on the response blocks framing whatever the CSP says.
 *    It is therefore dropped only when the list is non-empty, and the
 *    allow-list is carried by an ENFORCED
 *    `Content-Security-Policy: frame-ancestors <origins>`. The global
 *    CSP is still Report-Only, which would not stop anyone framing the
 *    page, so the frame rule cannot ride on it.
 *  - With no usable origin (empty list, unknown or switched-off token,
 *    lookup error) the answer is `frame-ancestors 'none'` plus
 *    `X-Frame-Options: DENY`, as strict as every other page.
 *  - The global Report-Only policy is still sent on /f/, with its
 *    `frame-ancestors` restated to match the enforced one, so an
 *    allowed embed does not log a report for every page view.
 *
 * Only what `normalizeAllowedOrigin` accepts (https, host and optional
 * port, nothing else) becomes a source: never `*`, a bare scheme, a
 * path, a quote, a space or a `;` that could start another directive.
 * At most MAX_ALLOWED_ORIGINS sources, the same cap as the settings.
 */

import { MAX_ALLOWED_ORIGINS, normalizeAllowedOrigin } from './origin';

export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

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
 * The frame headers for one `/f/<token>` response. `reportOnlyCsp` is
 * the global Report-Only policy (src/lib/csp.ts); when given, it is
 * returned with the same frame-ancestors as the enforced header.
 */
export function frameHeadersFor(
  allowedOrigins: readonly unknown[] | null | undefined,
  opts: { reportOnlyCsp?: string } = {}
): Record<string, string> {
  const directive = frameAncestorsDirective(allowedOrigins);
  const headers: Record<string, string> = {
    'Content-Security-Policy': directive,
  };
  if (directive === FRAME_ANCESTORS_NONE) headers['X-Frame-Options'] = 'DENY';
  if (opts.reportOnlyCsp) {
    headers['Content-Security-Policy-Report-Only'] = withFrameAncestors(
      opts.reportOnlyCsp,
      directive
    );
  }
  return headers;
}
