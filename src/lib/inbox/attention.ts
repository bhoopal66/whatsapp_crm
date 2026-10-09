import type { Conversation } from '@/types';

/**
 * Chats the AI handed to a person (migration 078,
 * `conversations.ai_attention_at`). The inbox pins them above every
 * other chat with a red Important label until someone acts: a person's
 * reply clears the stamp (a messages trigger), as do Take over, Resume
 * and acting on a held draft. Pure, so the order is tested without a
 * database.
 */

/**
 * The most attention rows the first page asks for alongside the normal
 * page. Past this they still arrive, unpinned until loaded, with the
 * page their last message falls in.
 */
export const ATTENTION_LIMIT = 100;

function time(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/** Whether the AI handed this chat to a person and nobody has acted yet. */
export function needsAttention(
  conv: Pick<Conversation, 'ai_attention_at'>
): boolean {
  return time(conv.ai_attention_at) !== null;
}

type Sortable = Pick<
  Conversation,
  'id' | 'last_message_at' | 'ai_attention_at'
>;

/**
 * The inbox order: chats needing attention first, the newest hand-off
 * on top; then every other chat newest message first. `id DESC` breaks
 * ties as the query does, and a row without a timestamp goes last.
 */
export function compareForInbox(a: Sortable, b: Sortable): number {
  const aAttn = time(a.ai_attention_at);
  const bAttn = time(b.ai_attention_at);
  if (aAttn !== bAttn) {
    if (aAttn === null) return 1;
    if (bAttn === null) return -1;
    return bAttn - aAttn;
  }
  const aAt = time(a.last_message_at);
  const bAt = time(b.last_message_at);
  if (aAt !== bAt) {
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return bAt - aAt;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The list in display order (see {@link compareForInbox}). Realtime
 * patches rows in place — a new message, a hand-off, a person's reply
 * clearing it — so the list re-sorts on every change. Returns a copy.
 */
export function sortForInbox<T extends Sortable>(rows: readonly T[]): T[] {
  return rows.slice().sort(compareForInbox);
}

/** How many of `rows` need attention. */
export function countNeedingAttention(
  rows: readonly Pick<Conversation, 'ai_attention_at'>[]
): number {
  let n = 0;
  for (const r of rows) if (needsAttention(r)) n++;
  return n;
}
