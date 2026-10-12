/**
 * Pure helpers for the team-chat search screen (/chat?search=<q>):
 * grouping the ranked hits of `chat_search` by channel, the snippet
 * shown for each hit and which parts of it to highlight, and the people
 * whose name matches. The node test environment covers them.
 */
import { mentionSegments, type MentionSegment } from './mentions';
import type { ChatPerson, SearchHit } from './types';

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/**
 * Arabic-Indic and Extended Arabic-Indic digits → ASCII, as
 * chat_normalize_digits (087) does before the server matches. One code
 * unit in, one out, so indices into the result are indices into `s`.
 */
export function normalizeDigits(s: string): string {
  return s.replace(ARABIC_INDIC, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** Lower-cased per code unit, so the result stays index-aligned with `s`. */
function fold(s: string): string {
  let out = '';
  for (const ch of normalizeDigits(s)) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/** The distinct words of a query, folded; quotes and operators dropped. */
export function queryTerms(q: string): string[] {
  const words = fold(q)
    .replace(/["()]/g, ' ')
    .split(/\s+/u)
    .map((w) => w.replace(/^[-+]+/, ''))
    .filter((w) => w && w !== 'or');
  return [...new Set(words)];
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** `text` split into runs that match one of `terms` (case- and digit-insensitive) and runs that don't. */
export function highlightSegments(
  text: string,
  terms: readonly string[]
): HighlightSegment[] {
  if (!text) return [];
  const hay = fold(text);
  const marks: boolean[] = new Array(text.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    for (let at = hay.indexOf(term); at !== -1; at = hay.indexOf(term, at + 1))
      for (let i = at; i < at + term.length; i++) marks[i] = true;
  }
  const out: HighlightSegment[] = [];
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push({ text: text.slice(i, j), hit: marks[i] });
    i = j;
  }
  return out;
}

export interface Snippet {
  text: string;
  /** Text was cut before / after the snippet. */
  before: boolean;
  after: boolean;
}

const MENTION_TOKEN = /<@[0-9a-fA-F-]{36}>/g;

/**
 * At most about `max` characters of `body` around the first match,
 * never cutting a `<@uuid>` mention token in half.
 */
export function searchSnippet(
  body: string,
  terms: readonly string[],
  max = 160
): Snippet {
  if (body.length <= max) return { text: body, before: false, after: false };
  const hay = fold(body);
  const first = terms
    .map((t) => (t ? hay.indexOf(t) : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  let start = first === undefined ? 0 : Math.max(0, first - 40);
  let end = Math.min(body.length, start + max);
  for (const m of body.matchAll(MENTION_TOKEN)) {
    const a = m.index;
    const b = a + m[0].length;
    if (start > a && start < b) start = a;
    if (end > a && end < b) end = b;
  }
  return {
    text: body.slice(start, end),
    before: start > 0,
    after: end < body.length,
  };
}

export type SnippetPart =
  | { type: 'text'; text: string; hit: boolean }
  | Exclude<MentionSegment, { type: 'text' }>;

/** A snippet ready to render: mention chips, and highlighted text runs. */
export function snippetParts(
  text: string,
  terms: readonly string[],
  people: ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>
): SnippetPart[] {
  return mentionSegments(text, people).flatMap((s): SnippetPart[] =>
    s.type === 'text'
      ? highlightSegments(s.text, terms).map((h) => ({ type: 'text', ...h }))
      : [s]
  );
}

export interface SearchGroup {
  channelId: string;
  hits: SearchHit[];
}

/**
 * Hits grouped by channel. Groups keep the order of their best-ranked
 * hit, and hits within a group keep the server's ranked order.
 */
export function groupSearchHits(hits: readonly SearchHit[]): SearchGroup[] {
  const byChannel = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const list = byChannel.get(h.channelId) ?? [];
    list.push(h);
    byChannel.set(h.channelId, list);
  }
  return [...byChannel].map(([channelId, list]) => ({ channelId, hits: list }));
}

/** Where a hit opens: its channel, and the thread for a reply. */
export function searchHitHref(
  hit: Pick<SearchHit, 'channelId' | 'threadRootId'>
): string {
  const base = `/chat/${encodeURIComponent(hit.channelId)}`;
  return hit.threadRootId
    ? `${base}?thread=${encodeURIComponent(hit.threadRootId)}`
    : base;
}

/** People whose name contains every query word, by name; at most `limit`. */
export function matchPeople<P extends Pick<ChatPerson, 'userId' | 'fullName'>>(
  people: readonly P[],
  q: string,
  limit = 6
): P[] {
  const terms = queryTerms(q);
  if (terms.length === 0) return [];
  return people
    .filter((p) => {
      const name = fold(p.fullName ?? '');
      return !!name && terms.every((t) => name.includes(t));
    })
    .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? ''))
    .slice(0, limit);
}
