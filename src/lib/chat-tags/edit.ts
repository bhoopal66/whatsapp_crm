import type { ChatTag } from '@/types';

/**
 * The Settings editor's rules for chat tags (migration 075), kept pure
 * so they can be tested without a database. The database holds the
 * same limits as constraints; these exist to say what is wrong before
 * a write is refused.
 */

/** Longest tag name, in characters (the column's CHECK). */
export const CHAT_TAG_NAME_MAX = 40;

/** Longest caption for a main tag's sub-tags ("Bank"). */
export const CHAT_TAG_SUB_TITLE_MAX = 30;

/**
 * The palette an admin picks from. `name` doubles as an i18n key
 * suffix, so renaming one is a catalogue change.
 */
export const CHAT_TAG_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'teal', value: '#14b8a6' },
  { name: 'sky', value: '#0ea5e9' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
  { name: 'slate', value: '#64748b' },
] as const satisfies readonly { name: string; value: string }[];

export type ChatTagColorName = (typeof CHAT_TAG_COLORS)[number]['name'];

/** Trim, and collapse internal runs of whitespace to one space. */
export function normalizeChatTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * What is wrong with a name, or null. Names are compared normalized and
 * case-insensitively among siblings (the database's uniqueness rule),
 * ignoring the row being renamed, so changing only the case of a tag's
 * own name is allowed. Length counts characters, not UTF-16 units, as
 * Postgres's `char_length` does.
 */
export function validateChatTagName(
  raw: string,
  siblings: readonly Pick<ChatTag, 'id' | 'name'>[],
  selfId?: string
): 'empty' | 'too_long' | 'duplicate' | null {
  const name = normalizeChatTagName(raw);
  if (name.length === 0) return 'empty';
  if ([...name].length > CHAT_TAG_NAME_MAX) return 'too_long';
  const key = name.toLowerCase();
  const taken = siblings.some(
    (s) => s.id !== selfId && normalizeChatTagName(s.name).toLowerCase() === key
  );
  return taken ? 'duplicate' : null;
}

/** A main tag's sub-tag caption, normalized; blank means none. */
export function normalizeSubTagTitle(raw: string): string | null {
  const title = normalizeChatTagName(raw);
  return title.length === 0 ? null : title;
}

/** Position for a new tag at the end of its siblings. */
export function nextChatTagPosition(
  siblings: readonly Pick<ChatTag, 'position'>[]
): number {
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((s) => s.position)) + 1;
}

/**
 * Move one tag a step up or down among its siblings, which arrive in
 * display order. Returns the position writes that make the new order
 * read 0..n-1 — only for rows whose stored position changes, so stored
 * positions that collide or have gaps are repaired along the way. At
 * either end, or for an unknown id, there is nothing to write.
 */
export function moveChatTag(
  siblings: readonly Pick<ChatTag, 'id' | 'position'>[],
  id: string,
  dir: 'up' | 'down'
): { id: string; position: number }[] {
  const from = siblings.findIndex((s) => s.id === id);
  if (from === -1) return [];
  const to = dir === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= siblings.length) return [];
  const order = [...siblings];
  [order[from], order[to]] = [order[to], order[from]];
  const writes: { id: string; position: number }[] = [];
  order.forEach((s, i) => {
    if (s.position !== i) writes.push({ id: s.id, position: i });
  });
  return writes;
}
