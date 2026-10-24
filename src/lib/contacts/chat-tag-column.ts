import type { Conversation } from '@/types';
import {
  chatTagLabel,
  resolveConversationChatTags,
  type ChatTagTree,
} from '@/lib/chat-tags/tree';

/**
 * The Contacts screens show a contact's chat tag (migration 075) — the
 * tag on its conversation — in place of the retired contact tags. This
 * is the pure part: which conversation speaks for a contact, how the
 * chip reads, and how the chat-tag filter's contact ids are paged
 * through PostgREST.
 */

/** A conversation's chat tag ids, as the list reads them. */
export type ChatTagIds = Pick<Conversation, 'chat_tag_id' | 'chat_sub_tag_id'>;

/**
 * PostgREST puts `.in()` ids in the query string; 200 UUIDs (~7.4 kB)
 * stays well inside what the tunnel and Kong accept.
 */
export const CONTACT_ID_CHUNK = 200;

/** Split `ids` into consecutive chunks of at most `size`. */
export function chunkIds<T>(
  ids: readonly T[],
  size: number = CONTACT_ID_CHUNK
): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/** One page of a PostgREST read: rows `from`..`to`, inclusive. */
export type PageFetcher<T> = (
  from: number,
  to: number
) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Read every row of a query, `pageSize` at a time, in the query's own
 * (stable) order. Stops on an EMPTY page, never a short one: PostgREST
 * caps each response at its `max-rows`, so an install whose cap is
 * below `pageSize` answers every page short, and stopping there would
 * silently drop all but the first page (the bug `fetchAllPages` in
 * `use-broadcast-sending.ts` documents). The next page starts after the
 * rows actually received, so a capped page leaves no gap.
 */
export async function readAllPages<T>(
  fetchPage: PageFetcher<T>,
  pageSize: number
): Promise<
  { data: T[]; error: null } | { data: null; error: { message: string } }
> {
  if (pageSize < 1) throw new RangeError('page size must be at least 1');
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await fetchPage(
      rows.length,
      rows.length + pageSize - 1
    );
    if (error) return { data: null, error };
    if (!data || data.length === 0) return { data: rows, error: null };
    rows.push(...data);
  }
}

/**
 * `fn` over every item with at most `limit` calls in flight, results in
 * the items' order. The chat-tag filter reads its contacts 200 ids per
 * request; firing them all at once through the tunnel queues dozens of
 * requests behind each other and starves the rest of the page.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => PromiseLike<R>
): Promise<R[]> {
  if (limit < 1) throw new RangeError('concurrency limit must be at least 1');
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * The chat tag ids per contact. A contact has one conversation, but if
 * an old install left two, the first one carrying a tag speaks for it —
 * the same answer the filter gives, which matches a contact when ANY of
 * its conversations matches. `rows` must be in the order to prefer —
 * oldest first (`created_at` ascending), in the list and in the
 * contact's detail view alike, so the two always show the same tag.
 */
export function chatTagsByContact(
  rows: readonly (ChatTagIds & { contact_id: string })[]
): Map<string, ChatTagIds> {
  const byContact = new Map<string, ChatTagIds>();
  for (const row of rows) {
    const current = byContact.get(row.contact_id);
    if (current?.chat_tag_id) continue;
    byContact.set(row.contact_id, {
      chat_tag_id: row.chat_tag_id ?? null,
      chat_sub_tag_id: row.chat_sub_tag_id ?? null,
    });
  }
  return byContact;
}

/**
 * contact id → the auth user id its chat is assigned to, for the
 * "Assigned to" column: the first conversation (in the rows' order)
 * that has an assignee. A contact whose chats are all unassigned is
 * absent.
 */
export function assigneesByContact(
  rows: readonly { contact_id: string; assigned_agent_id?: string | null }[]
): Map<string, string> {
  const byContact = new Map<string, string>();
  for (const row of rows) {
    if (!row.assigned_agent_id || byContact.has(row.contact_id)) continue;
    byContact.set(row.contact_id, row.assigned_agent_id);
  }
  return byContact;
}

/** What the chip shows: `"Interested customer · ADCB"` and its colour. */
export interface ChatTagChip {
  label: string;
  color: string;
}

/**
 * The chip for a contact's chat tag, or null for none — including ids
 * the tree does not know (a tag deleted a moment ago).
 */
export function contactChatTagChip(
  ids: ChatTagIds | null | undefined,
  tree: ChatTagTree
): ChatTagChip | null {
  if (!ids) return null;
  const { main, sub } = resolveConversationChatTags(ids, tree);
  const label = chatTagLabel(main, sub);
  return main && label ? { label, color: main.color } : null;
}

/**
 * The chip for a tag picked in the filter: a main tag by its name, a
 * sub-tag as `"Main · Sub"` so two banks under different mains stay
 * apart. Null for an id the tree does not know.
 */
export function chatTagFilterChip(
  id: string,
  tree: ChatTagTree
): ChatTagChip | null {
  const tag = tree.byId.get(id);
  if (!tag) return null;
  if (tag.parent_id === null) return { label: tag.name, color: tag.color };
  const main = tree.byId.get(tag.parent_id) ?? null;
  return { label: chatTagLabel(main, tag) ?? tag.name, color: tag.color };
}

/**
 * One page of the filtered list, in the order the unfiltered list
 * uses (newest first). `rows` are every matching contact's id and
 * `created_at`, gathered chunk by chunk; ties fall back to the id so
 * the pages never overlap.
 */
export function pageOfContactIds(
  rows: readonly { id: string; created_at: string }[],
  from: number,
  size: number
): { ids: string[]; total: number } {
  const sorted = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return {
    ids: sorted.slice(from, from + size).map((r) => r.id),
    total: sorted.length,
  };
}
