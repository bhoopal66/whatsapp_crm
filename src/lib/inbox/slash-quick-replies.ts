/**
 * "/" quick replies in the inbox composer: typing "/" at the start of
 * the message box opens a filtered list of the account's quick replies.
 * Pure (no I/O, no DOM): token detection, matching and insertion, so the
 * composer only wires keys and clicks. The quick-reply picker's search
 * box uses the same matcher.
 */

/** What the matcher reads of a quick reply (a `QuickReply` fits). */
export interface MatchableQuickReply {
  title: string;
  content_text?: string | null;
}

/** The "/query" at the start of the box. */
export interface SlashToken {
  /** Text after the slash, as typed (not trimmed). */
  query: string;
  /** Always 0: the token only counts at the start of the box. */
  start: number;
  /** End of the token (exclusive): the end of the first line. */
  end: number;
}

/** A query longer than this is a message, not a search. */
export const SLASH_QUERY_MAX = 40;

/** How many matches the "/" list shows. */
export const SLASH_LIST_LIMIT = 8;

/**
 * The slash token, when the box starts with "/" and the caret sits on
 * that first line after the slash. The token runs to the end of the
 * first line, so "/wel" followed by more lines replaces only "/wel".
 * "/ " (a space straight after the slash) and over-long queries are not
 * tokens: someone writing a message that happens to start with a slash
 * gets no list in the way.
 */
export function detectSlashToken(
  text: string,
  caret: number | null | undefined
): SlashToken | null {
  if (!text.startsWith('/')) return null;
  const newline = text.indexOf('\n');
  const end = newline === -1 ? text.length : newline;
  const at = caret ?? end;
  if (at < 1 || at > end) return null;
  const query = text.slice(1, end);
  if (/^\s/.test(query)) return null;
  if (query.length > SLASH_QUERY_MAX) return null;
  return { query, start: 0, end };
}

/** Lower case, accents and punctuation folded to single spaces. */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The shortcut a quick reply answers to after "/": its title in lower
 * case with words joined by "-" ("Welcome message" → "welcome-message").
 * Quick replies have no shortcut column, so the title is the shortcut.
 */
export function quickReplyShortcut(qr: MatchableQuickReply): string {
  return fold(qr.title).replace(/ /g, '-');
}

/**
 * Rank of `qr` for `query` (lower is better), or null for no match.
 *   0 shortcut starts with the query
 *   1 a title word starts with the query
 *   2 the title contains the query
 *   3 the body contains the query
 */
function rank(qr: MatchableQuickReply, q: string): number | null {
  const shortcut = quickReplyShortcut(qr);
  const title = fold(qr.title);
  if (shortcut.startsWith(q.replace(/ /g, '-'))) return 0;
  if (` ${title}`.includes(` ${q}`)) return 1;
  if (title.includes(q)) return 2;
  if (fold(qr.content_text ?? '').includes(q)) return 3;
  return null;
}

/**
 * Quick replies matching `query` on shortcut, title or body, best first
 * (ties keep the list's order). An empty query matches everything in
 * order. `limit` caps the result (Infinity for the picker's search).
 */
export function matchQuickReplies<T extends MatchableQuickReply>(
  items: readonly T[],
  query: string,
  limit: number = SLASH_LIST_LIMIT
): T[] {
  const q = fold(query);
  if (!q) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, r: rank(item, q) }))
    .filter((x): x is { item: T; index: number; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * Replace the slash token with `body`. Returns the new text and where
 * the caret goes (just after the inserted text).
 */
export function applySlashInsert(
  text: string,
  token: SlashToken,
  body: string
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  return {
    text: `${before}${body}${after}`,
    caret: before.length + body.length,
  };
}

/** Move a list highlight by `delta`, wrapping; -1 for an empty list. */
export function moveHighlight(
  current: number,
  delta: number,
  count: number
): number {
  if (count <= 0) return -1;
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return (((from + delta) % count) + count) % count;
}
