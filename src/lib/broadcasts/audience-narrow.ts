import { LEAD_SOURCES } from '@/lib/contacts/lead-source';

/**
 * The "Narrow this audience" filters of a broadcast (track D, U14):
 * match-all chat tags, a bank filter and a lead-source filter. Pure, so
 * the wizard's count and the send resolve them identically.
 *
 * Audiences are resolved in the browser (the server only replays the
 * frozen `broadcast_recipients`), so these helpers are shared by
 * `estimateAudience` and `resolveAudience` in `use-broadcast-sending.ts`.
 */

export type ChatTagMatch = 'any' | 'all';
export type BankSource = 'case' | 'chat_tag';

/** One conversation's chat-tag columns (one chat per contact). */
export interface TaggedChat {
  contact_id: string | null;
  chat_tag_id: string | null;
  chat_sub_tag_id: string | null;
}

export function normalizeChatTagMatch(value: unknown): ChatTagMatch {
  return value === 'all' ? 'all' : 'any';
}

/**
 * Does the chat carry the selected tags? 'any': its main tag or sub-tag
 * is one of them. 'all': it carries every one — a chat holds one main
 * tag and one sub-tag, so that is a main tag plus its sub-tag, and two
 * different main tags can never match. No selection matches nothing.
 */
export function chatMatchesTags(
  chat: Pick<TaggedChat, 'chat_tag_id' | 'chat_sub_tag_id'>,
  selectedIds: readonly string[],
  mode: ChatTagMatch
): boolean {
  const wanted = [...new Set(selectedIds)];
  if (wanted.length === 0) return false;
  const held = new Set(
    [chat.chat_tag_id, chat.chat_sub_tag_id].filter((x): x is string => !!x)
  );
  return mode === 'all'
    ? wanted.every((id) => held.has(id))
    : wanted.some((id) => held.has(id));
}

/** Distinct contact ids whose chat matches the selected tags. */
export function contactIdsForTags(
  chats: readonly TaggedChat[],
  selectedIds: readonly string[],
  mode: ChatTagMatch
): string[] {
  const out = new Set<string>();
  for (const chat of chats) {
    if (chat.contact_id && chatMatchesTags(chat, selectedIds, mode)) {
      out.add(chat.contact_id);
    }
  }
  return [...out];
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Sub-tags that stand for one of the picked banks: a sub-tag (a tag with
 * a parent) whose name equals the bank's name or code, case-insensitive
 * ("Bank: ADCB" is only the caption the picker shows, the tag is named
 * "ADCB").
 */
export function bankSubTagIds(
  tags: readonly { id: string; parent_id: string | null; name: string }[],
  banks: readonly { code: string; name?: string | null }[]
): string[] {
  const names = new Set<string>();
  for (const b of banks) {
    if (norm(b.code)) names.add(norm(b.code));
    if (norm(b.name)) names.add(norm(b.name));
  }
  if (names.size === 0) return [];
  return tags
    .filter((t) => t.parent_id !== null && names.has(norm(t.name)))
    .map((t) => t.id);
}

/**
 * Intersect optional id sets: null means "this filter is not set" and
 * is skipped; all null gives null (no narrowing at all).
 */
export function intersectIdSets(
  sets: readonly (ReadonlySet<string> | null | undefined)[]
): Set<string> | null {
  let acc: Set<string> | null = null;
  for (const s of sets) {
    if (!s) continue;
    if (acc === null) {
      acc = new Set(s);
    } else {
      const prev: Set<string> = acc;
      acc = new Set([...prev].filter((x) => s.has(x)));
    }
  }
  return acc;
}

export interface Narrowing {
  chatTagMatch: ChatTagMatch;
  bankCodes: string[];
  bankSource: BankSource;
  leadSources: string[];
}

/** Clean a stored/typed narrowing: known sources, distinct codes. */
export function normalizeNarrowing(raw: {
  chatTagMatch?: unknown;
  bankCodes?: unknown;
  bankSource?: unknown;
  leadSources?: unknown;
}): Narrowing {
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string'))]
      : [];
  const known = new Set<string>(LEAD_SOURCES);
  return {
    chatTagMatch: normalizeChatTagMatch(raw.chatTagMatch),
    bankCodes: strings(raw.bankCodes).filter((c) => c.trim() !== ''),
    bankSource: raw.bankSource === 'chat_tag' ? 'chat_tag' : 'case',
    leadSources: strings(raw.leadSources).filter((s) => known.has(s)),
  };
}

/** True when a bank or lead-source filter is set. */
export function hasNarrowing(
  n: Pick<Narrowing, 'bankCodes' | 'leadSources'>
): boolean {
  return n.bankCodes.length > 0 || n.leadSources.length > 0;
}
