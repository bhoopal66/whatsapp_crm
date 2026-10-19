// ============================================================
// The body of POST …/memory/search (019b). The search text travels in
// the body, never the URL, so an ID number typed into search stays out
// of proxy and access logs.
// ============================================================

export const SEARCH_Q_MAX = 500;
export const SEARCH_LIMIT_MAX = 100;
export const SEARCH_LIMIT_DEFAULT = 20;

/**
 * `{ q (1–500 characters once trimmed), limit? (1–100, default 20) }`,
 * or the 400 message. The message never quotes the body.
 */
export function parseMemorySearch(
  body: Record<string, unknown> | null
): { ok: true; q: string; limit: number } | { ok: false; error: string } {
  const q = typeof body?.q === 'string' ? body.q.trim() : '';
  const length = [...q].length;
  if (length < 1 || length > SEARCH_Q_MAX)
    return { ok: false, error: `q must be 1–${SEARCH_Q_MAX} characters` };
  const raw = body?.limit;
  if (raw === undefined || raw === null)
    return { ok: true, q, limit: SEARCH_LIMIT_DEFAULT };
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > SEARCH_LIMIT_MAX
  )
    return {
      ok: false,
      error: `limit must be a whole number 1–${SEARCH_LIMIT_MAX}`,
    };
  return { ok: true, q, limit: raw };
}
