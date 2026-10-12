/**
 * Mention tokens, as chat_post_message (087) records them:
 *   user:      <@uuid>, any case.
 *   broadcast: @channel / @here, any case, not preceded or followed by a
 *              letter, digit or underscore. Postgres's [:alnum:] is
 *              Unicode-aware, hence \p{L}\p{N} here.
 * Ported from the 014b package; keep both regexes in step with the SQL.
 */
import type { BroadcastKind, ChatPerson } from './types';

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const userToken = () => new RegExp(`<@(${UUID})>`, 'g');
const broadcastToken = () =>
  /(?:^|[^\p{L}\p{N}_])@(channel|here)(?![\p{L}\p{N}_])/giu;

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && UUID_RE.test(s);

/** `<@uuid>` for a user id; throws on anything that is not a uuid. */
export function formatMention(userId: string): string {
  if (!isUuid(userId))
    throw new TypeError(`formatMention: not a uuid: ${String(userId)}`);
  return `<@${userId.toLowerCase()}>`;
}

export interface ParsedMentions {
  /** Distinct lower-case user ids, in order of first appearance. */
  userIds: string[];
  /** Distinct broadcast kinds, in order of first appearance. */
  broadcast: BroadcastKind[];
}

/** The mentions chat_post_message will record (before its readability filter). */
export function parseMentions(body: string): ParsedMentions {
  const userIds = [
    ...new Set([...body.matchAll(userToken())].map((m) => m[1].toLowerCase())),
  ];
  const broadcast = [
    ...new Set(
      [...body.matchAll(broadcastToken())].map(
        (m) => m[1].toLowerCase() as BroadcastKind
      )
    ),
  ];
  return { userIds, broadcast };
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string; name: string | null }
  | { type: 'broadcast'; kind: BroadcastKind };

/** A body split for rendering: text runs, user chips (name null if unknown), broadcast chips. */
export function mentionSegments(
  body: string,
  people: ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>
): MentionSegment[] {
  const names = new Map(
    people.map((p) => [p.userId.toLowerCase(), p.fullName])
  );
  const tokens: { start: number; end: number; seg: MentionSegment }[] = [];
  for (const m of body.matchAll(userToken())) {
    const userId = m[1].toLowerCase();
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      seg: { type: 'mention', userId, name: names.get(userId) ?? null },
    });
  }
  for (const m of body.matchAll(broadcastToken())) {
    const kind = m[1].toLowerCase() as BroadcastKind;
    const start = m.index + m[0].length - (kind.length + 1);
    tokens.push({
      start,
      end: m.index + m[0].length,
      seg: { type: 'broadcast', kind },
    });
  }
  tokens.sort((a, b) => a.start - b.start);
  const out: MentionSegment[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.start > at) out.push({ type: 'text', text: body.slice(at, t.start) });
    out.push(t.seg);
    at = t.end;
  }
  if (at < body.length) out.push({ type: 'text', text: body.slice(at) });
  return out;
}

/** The '@query' being typed just before the caret (an '@' at the start or after whitespace), if any. */
export function mentionQueryAt(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}

/**
 * Inserts `<@uuid> ` for `person` at the caret, replacing an '@query'
 * being typed there; returns the new text and caret (after the space).
 */
export function insertMentionAt(
  text: string,
  caret: number,
  person: Pick<ChatPerson, 'userId'>
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const q = mentionQueryAt(text, at);
  let start = q ? q.start : at;
  let token = `${formatMention(person.userId)} `;
  if (!q && start > 0 && !/\s/u.test(text[start - 1])) token = ` ${token}`;
  const rest = text.slice(at);
  if (rest.startsWith(' ')) token = token.trimEnd();
  const next = text.slice(0, start) + token + rest;
  start += token.length + (rest.startsWith(' ') ? 1 : 0);
  return { text: next, caret: start };
}
