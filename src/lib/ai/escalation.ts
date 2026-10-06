// ============================================================
// Gate 1 — escalation keywords.
//
// A deterministic check that runs on the latest customer message BEFORE
// the auto-reply bot spends a token: if the message contains any of the
// account's escalation words/phrases (refund, complaint, legal, a
// manager, their Arabic equivalents…) the thread goes straight to a
// human. The prompt already asks the model to hand off in these cases;
// this makes it a guarantee instead of a request.
//
// Matching rules, kept deliberately small:
//   - case-insensitive, Unicode-aware, so Arabic / Korean lists work;
//   - a keyword must sit on word boundaries (`refund` does not fire on
//     "preferred", nor on "refunded") — boundaries are "not a letter or
//     digit", not `\b`, because `\b` is ASCII-only in JS;
//   - a trailing `*` relaxes the end boundary to a prefix match, which
//     is how an admin gets stemming without us shipping a stemmer:
//     `refund*` → refund, refunds, refunded, refunding;
//   - multi-word phrases match as a whole ("close my account").
// ============================================================

/** Max keywords an account may configure — a sanity cap, not a limit
 *  anyone should hit. */
export const MAX_ESCALATION_KEYWORDS = 200;

/** Longest single keyword/phrase accepted. */
export const MAX_ESCALATION_KEYWORD_LENGTH = 80;

/**
 * Normalize a raw admin-entered list (textarea: one per line, commas
 * also accepted) into the stored array: trimmed, lower-cased,
 * de-duplicated, empties and over-long entries dropped, capped.
 */
export function parseEscalationKeywords(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/[\n,]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const kw = part.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!kw || kw === '*') continue;
    if (kw.length > MAX_ESCALATION_KEYWORD_LENGTH) continue;
    if (seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= MAX_ESCALATION_KEYWORDS) break;
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build one regex per keyword. Cached per call site by the caller if
 *  needed — the list is short and the check runs once per inbound. */
function keywordPattern(keyword: string): RegExp {
  const prefix = keyword.endsWith('*');
  const body = prefix ? keyword.slice(0, -1) : keyword;
  // Word boundary = start/end of string or a non-alphanumeric character.
  const lead = '(?:^|[^\\p{L}\\p{N}])';
  const trail = prefix ? '' : '(?:$|[^\\p{L}\\p{N}])';
  return new RegExp(`${lead}${escapeRegex(body)}${trail}`, 'iu');
}

/**
 * Return the first configured keyword that occurs in `text`, or null.
 * The keyword (as configured, e.g. `refund*`) is what gets written into
 * the handoff note so the agent sees *why* the bot stepped aside.
 */
export function matchEscalationKeyword(
  text: string,
  keywords: readonly string[]
): string | null {
  const haystack = text.trim();
  if (!haystack || keywords.length === 0) return null;
  for (const kw of keywords) {
    const body = kw.endsWith('*') ? kw.slice(0, -1) : kw;
    if (!body) continue;
    if (keywordPattern(kw).test(haystack)) return kw;
  }
  return null;
}
