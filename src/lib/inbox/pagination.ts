import type { Conversation, Message, MessageReaction } from '@/types';
import { UNASSIGNED, type AssigneeFilter } from '@/lib/inbox/conversations';
import { needsAttention } from '@/lib/inbox/attention';

/**
 * Keyset pagination for the Inbox — the conversation list and the open
 * thread both load a page at a time instead of everything at once.
 *
 * Why: the list used to select every conversation the viewer could see
 * (silently truncated at PostgREST's max-rows, 1000) and the thread
 * every message in the conversation. Behind the Cloudflare tunnel each
 * of those was a multi-hundred-KB response on the critical path of
 * opening the inbox. Everything here is pure so the cursor maths and
 * the merge rules can be unit-tested without a database.
 */

export const CONVERSATION_PAGE_SIZE = 50;
export const MESSAGE_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Where the next conversation page starts. The list is ordered
 * `last_message_at DESC NULLS FIRST, id DESC` — NULLS FIRST only because
 * it is Postgres's default for DESC and matches the index (migration
 * 059); the page query excludes message-less rows (`hasMessages`), so the
 * null block is empty in practice. `id` breaks ties so
 * two rows sharing a timestamp can't straddle a page boundary and be
 * skipped or repeated.
 */
export interface ConversationCursor {
  lastMessageAt: string | null;
  id: string;
}

/**
 * Cursor after `page`, or `null` when the page came back short — i.e.
 * there is nothing more to load.
 */
export function nextConversationCursor(
  page: Pick<Conversation, 'id' | 'last_message_at'>[],
  pageSize: number = CONVERSATION_PAGE_SIZE
): ConversationCursor | null {
  if (page.length < pageSize || page.length === 0) return null;
  const last = page[page.length - 1];
  return { lastMessageAt: last.last_message_at ?? null, id: last.id };
}

/**
 * PostgREST values inside a logic tree (`or=(...)`) must be quoted when
 * they contain reserved characters — a timestamp carries `.` and `:`.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The `or` group (without the outer parentheses) selecting the rows that
 * sort strictly after `cursor` under the list's ordering.
 */
export function conversationKeysetGroup(cursor: ConversationCursor): string {
  if (cursor.lastMessageAt === null) {
    // Still inside the NULLS FIRST block: the remaining null rows with a
    // smaller id, then every row that has a timestamp at all.
    return `and(last_message_at.is.null,id.lt.${cursor.id}),last_message_at.not.is.null`;
  }
  const ts = quote(cursor.lastMessageAt);
  return `last_message_at.lt.${ts},and(last_message_at.eq.${ts},id.lt.${cursor.id})`;
}

/**
 * "I created it OR it was handed to me OR it is on (or pinned to) a
 * number I work" — the personal-inbox narrowing for a team leader, the
 * same grants the database's visibility rule makes (042, plus 060's
 * allocated numbers and 061's pins). Without the last two, a leader
 * allocated to a number would find its chats only in the Team inbox.
 */
export function restrictToUserGroup(
  userId: string,
  channelIds: readonly string[] = []
): string {
  const mine = `user_id.eq.${userId},assigned_agent_id.eq.${userId}`;
  if (channelIds.length === 0) return mine;
  const ids = channelIds.join(',');
  return `${mine},channel_id.in.(${ids}),send_channel_id.in.(${ids})`;
}

/**
 * Server-side form of {@link matchesAssignee} for a specific teammate:
 * assigned to them, or unassigned and owned by them. `null` for the
 * no-filter and {@link UNASSIGNED} cases — the latter is a plain
 * `assigned_agent_id IS NULL`, not an `or` group.
 */
export function assigneeGroup(filter: AssigneeFilter): string | null {
  if (filter === null || filter === UNASSIGNED) return null;
  return `assigned_agent_id.eq.${filter},and(assigned_agent_id.is.null,user_id.eq.${filter})`;
}

/**
 * Fold several `or` groups into the single string passed to `.or()`.
 *
 * Each group must hold on its own, so two or more are wrapped as
 * `and(or(g1),or(g2))` — one `or=` parameter rather than several, which
 * keeps the semantics independent of how PostgREST treats a repeated
 * query key.
 */
export function combineOrGroups(
  groups: (string | null | undefined)[]
): string | null {
  const present = groups.filter((g): g is string => !!g);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return `and(${present.map((g) => `or(${g})`).join(',')})`;
}

function time(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/**
 * Whether a conversation we don't hold would sort inside the pages
 * already loaded — i.e. it belongs on screen now, rather than turning up
 * when the user scrolls down to it.
 *
 * `cursor === null` means every page is loaded, so everything belongs.
 */
export function isWithinLoadedWindow(
  lastMessageAt: string | null | undefined,
  cursor: ConversationCursor | null
): boolean {
  if (cursor === null) return true;
  const at = time(lastMessageAt);
  // A message-less row sorts first (NULLS FIRST), so it is always inside.
  if (at === null) return true;
  // Still paging through the null block: no timestamped row is loaded.
  const floor = time(cursor.lastMessageAt);
  if (floor === null) return false;
  return at >= floor;
}

/**
 * Whether a conversation is shown in the list at all. As in WhatsApp, a
 * chat appears once it holds a message. A conversation row is created
 * before the first send reaches the gateway, and a failed send is never
 * written to `messages` (see failed-send.ts), so without this a send
 * that bounced left an empty chat — and NULLS FIRST pinned every such
 * chat above the real ones.
 */
export function hasMessages(
  conv: Pick<Conversation, 'last_message_at'>
): boolean {
  return time(conv.last_message_at) !== null;
}

/**
 * The list in display order: newest message first, `id DESC` breaking
 * ties as the query does. Realtime patches `last_message_at` in place,
 * so without re-sorting a chat that just got a message stayed where it
 * was instead of jumping to the top. Rows without a timestamp go last.
 */
export function sortByRecency<
  T extends Pick<Conversation, 'id' | 'last_message_at'>,
>(rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, at: time(row.last_message_at) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
      }
      return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0;
    })
    .map((x) => x.row);
}

/** Append a further page, skipping rows already held (realtime may have added them). */
export function appendConversationPage(
  existing: Conversation[],
  page: Conversation[]
): Conversation[] {
  if (page.length === 0) return existing;
  const known = new Set(existing.map((c) => c.id));
  const fresh = page.filter((c) => !known.has(c.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

/**
 * Merge a delta resync (rows changed since the tab went away) into the
 * list. Known rows take the fetched values — the same outcome the old
 * full reload produced for them — while keeping the joined contact if
 * the fetch somehow lacked one. Unknown rows are prepended only when
 * they belong inside the loaded window; anything older will arrive with
 * its page.
 */
export function mergeConversationDelta(
  existing: Conversation[],
  fetched: Conversation[],
  cursor: ConversationCursor | null
): Conversation[] {
  if (fetched.length === 0) return existing;
  const byId = new Map(fetched.map((c) => [c.id, c]));
  let changed = false;
  const patched = existing.map((c) => {
    const f = byId.get(c.id);
    if (!f) return c;
    byId.delete(c.id);
    changed = true;
    return { ...c, ...f, contact: f.contact ?? c.contact };
  });
  // A chat needing attention is pinned at the top (attention.ts), so it
  // belongs on screen wherever its last message falls.
  const prepend = [...byId.values()].filter(
    (c) => needsAttention(c) || isWithinLoadedWindow(c.last_message_at, cursor)
  );
  if (!changed && prepend.length === 0) return existing;
  return [...prepend, ...patched];
}

/**
 * Newest `updated_at` held, minus a safety margin — the watermark a
 * delta resync asks "what changed since". Server-clock values only, so
 * a skewed client clock can't open a gap. The margin covers
 * transactions that committed out of order around the moment it was
 * taken. `null` (nothing to anchor on) means "do a full reload".
 */
export function deltaWatermark(
  rows: Pick<Conversation, 'updated_at'>[],
  marginMs = 60_000
): string | null {
  let max: number | null = null;
  for (const r of rows) {
    const t = time(r.updated_at);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max - marginMs).toISOString();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A thread page is fetched newest-first (`created_at DESC, id DESC`, so
 * `LIMIT` keeps the latest) and displayed oldest-first.
 */
export function toChronological<T>(pageDesc: T[]): T[] {
  return pageDesc.slice().reverse();
}

/** The `or` group selecting messages strictly older than `oldest`. */
export function olderMessagesGroup(
  oldest: Pick<Message, 'id' | 'created_at'>
): string {
  const ts = quote(oldest.created_at);
  return `created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${oldest.id})`;
}

/** Oldest persisted (non-optimistic) message — the cursor for the next older page. */
export function oldestPersisted<T extends Pick<Message, 'id'>>(
  messages: T[]
): T | null {
  for (const m of messages) if (!m.id.startsWith('temp-')) return m;
  return null;
}

/** Prepend an older page, skipping anything already held. */
export function prependOlderMessages(
  existing: Message[],
  olderChrono: Message[]
): Message[] {
  if (olderChrono.length === 0) return existing;
  const known = new Set(existing.map((m) => m.id));
  const fresh = olderChrono.filter((m) => !known.has(m.id));
  return fresh.length === 0 ? existing : [...fresh, ...existing];
}

/**
 * Fold a re-read of the latest page into the thread without dropping the
 * older pages the user scrolled back through.
 *
 * - Held messages take the fetched values (status ticks missed while
 *   the tab was away).
 * - New messages are appended in created_at order.
 * - Optimistic `temp-` bubbles survive only while still `sending`; a
 *   sent/failed temp is exactly what the old full reload discarded, and
 *   a sent one's real row is in the page.
 * - `gap` is set when the page is full and shares nothing with what we
 *   hold — more arrived than one page, so the caller should replace the
 *   thread with the page rather than stitch across a hole.
 */
export function mergeLatestMessages(
  existing: Message[],
  latestChrono: Message[],
  pageSize: number = MESSAGE_PAGE_SIZE
): { messages: Message[]; gap: boolean } {
  const persisted = existing.filter((m) => !m.id.startsWith('temp-'));
  const fetchedIds = new Set(latestChrono.map((m) => m.id));
  const overlaps = persisted.some((m) => fetchedIds.has(m.id));

  if (persisted.length > 0 && !overlaps && latestChrono.length >= pageSize) {
    const newestHeld = time(persisted[persisted.length - 1].created_at);
    const oldestFetched = time(latestChrono[0]?.created_at);
    if (
      newestHeld === null ||
      oldestFetched === null ||
      oldestFetched >= newestHeld
    ) {
      return { messages: latestChrono, gap: true };
    }
  }

  const byId = new Map(latestChrono.map((m) => [m.id, m]));
  const merged: Message[] = [];
  for (const m of existing) {
    if (m.id.startsWith('temp-')) {
      if (m.status === 'sending') merged.push(m);
      continue;
    }
    const f = byId.get(m.id);
    if (f) {
      merged.push({ ...m, ...f });
      byId.delete(m.id);
    } else {
      merged.push(m);
    }
  }
  const added = [...byId.values()];
  if (added.length === 0) return { messages: merged, gap: false };

  // Stable sort keeps same-timestamp rows in their fetched order.
  const all = [...merged, ...added];
  const indexed = all.map((m, i) => ({ m, i, t: time(m.created_at) ?? 0 }));
  indexed.sort((a, b) => a.t - b.t || a.i - b.i);
  return { messages: indexed.map((x) => x.m), gap: false };
}

/** A message row as read with its reactions embedded. */
export type MessageWithReactions = Message & {
  reactions?: MessageReaction[] | null;
};

/**
 * Select for a thread page: the message row plus its reactions, embedded
 * through `message_reactions.message_id → messages.id`.
 */
export const MESSAGE_PAGE_SELECT = '*, reactions:message_reactions(*)';

/**
 * Split rows read with {@link MESSAGE_PAGE_SELECT} into the plain
 * messages the thread renders and the flat reaction list it keeps —
 * one round trip for both instead of two.
 */
export function splitEmbeddedReactions(rows: MessageWithReactions[]): {
  messages: Message[];
  reactions: MessageReaction[];
} {
  const messages: Message[] = [];
  const reactions: MessageReaction[] = [];
  for (const row of rows) {
    const { reactions: embedded, ...msg } = row;
    messages.push(msg as Message);
    if (embedded) reactions.push(...embedded);
  }
  return { messages, reactions };
}

/**
 * Replace the reactions of `messageIds` with `fetched`, leaving every
 * other message's reactions (and in-flight optimistic ones) alone.
 */
export function replaceReactionsFor(
  existing: MessageReaction[],
  messageIds: Iterable<string>,
  fetched: MessageReaction[]
): MessageReaction[] {
  const ids = new Set(messageIds);
  const key = (r: MessageReaction) =>
    `${r.message_id}|${r.actor_type}|${r.actor_id ?? ''}`;
  const fetchedKeys = new Set(fetched.map(key));
  const kept = existing.filter((r) =>
    // An optimistic pill survives until its real row turns up.
    r.id.startsWith('temp-') ? !fetchedKeys.has(key(r)) : !ids.has(r.message_id)
  );
  const keptIds = new Set(kept.map((r) => r.id));
  return [...kept, ...fetched.filter((r) => !keptIds.has(r.id))];
}
