import { applyAvatars } from '@/lib/inbox/avatars';
import type { ConversationListItem } from '@/lib/inbox/conversations';
import type { Conversation } from '@/types';

// ============================================================
// Opening a chat: show the list row at once, fill in the full row.
//
// The Inbox list holds only the list's columns (CONVERSATION_LIST_SELECT).
// Opening a chat used to wait for the full row before showing the
// thread, so the thread's own messages read started one round trip
// late (~700 ms behind the tunnel), and the previous chat stayed on
// screen meanwhile. Now the list row opens the thread immediately, the
// full row is read in parallel, and it replaces the row when it lands,
// provided that chat is still the one open. Sections that read a
// full-only field (the AI banner's held draft and hand-off summary, the
// Call button's do-not-contact check, the contact panel) wait for `full`.
//
// A full-row read that misses is retried (FULL_ROW_RETRY_DELAYS_MS)
// while that chat is still the one asked for; a dropped read once left
// the chat half-loaded for good, with no way back but a page reload.
// An answer without the row is RLS saying the chat is no longer ours
// (handed away): asked once more, and then the chat is closed.
// ============================================================

/**
 * The open chat. `full: false` is a list row, shown while the full row
 * is in flight; `full: true` is the full row, after which nothing
 * downgrades it back to a list row.
 *
 * `patched` (list row only) is every field patch applied since the chat
 * opened, merged in arrival order. The full row is a snapshot that may
 * predate them, so they are re-applied on top of it (`applyFullRow`).
 */
export type ActiveChat =
  | { full: true; row: Conversation }
  | {
      full: false;
      row: ConversationListItem;
      patched?: Partial<Conversation>;
    };

/**
 * The full row's answer applied to the chat open *now*: only if it is
 * the same chat, otherwise `prev` itself, so a slow answer for a chat
 * the agent has left never lands on the one they picked.
 *
 * The full row supplies every full-only field (held draft, hand-off
 * summary, the whole contact), but the patches applied to the list row
 * while it was in flight win over it: PostgREST may have taken its
 * snapshot before a realtime UPDATE or a save that has already landed
 * here, and the older snapshot would roll back `channel_id`,
 * `unread_count`, `last_message_*` and the like. Re-applying patches
 * rather than comparing `updated_at` because a save's patch carries no
 * `updated_at`. A patch older than the snapshot can only be undone by
 * the newer change's own realtime event, which arrives after it.
 * Patches merge in arrival order, not server order: a save's own result
 * that lands after a newer realtime change of the same field shows until
 * the next event for that chat.
 */
export function applyFullRow(
  prev: ActiveChat | null,
  full: Conversation
): ActiveChat | null {
  if (!prev || prev.row.id !== full.id) return prev;
  // Already full: the first answer won. A second read of the same chat
  // (a re-click, or away and back) holds an older-or-equal snapshot of
  // fields realtime has patched since, so it never replaces a full row.
  if (prev.full) return prev;
  if (!prev.patched) return { full: true, row: full };
  return { full: true, row: { ...full, ...prev.patched } };
}

/**
 * A field patch (a realtime UPDATE payload, a save's result) merged into
 * the open chat when it is that chat; otherwise `prev` itself. `full`
 * is kept as it was: a patch never upgrades a list row (it does not
 * carry the full-only fields that matter) and never downgrades a full
 * row. `contact` is ignored: realtime payloads carry no join, and a
 * list row's five-column contact must not replace the full contact.
 * On a list row the patch is also kept in `patched`, for the full row.
 */
export function patchActiveChat(
  prev: ActiveChat | null,
  conversationId: string,
  patch: Partial<Conversation>
): ActiveChat | null {
  if (!prev || prev.row.id !== conversationId) return prev;
  const fields = { ...patch };
  delete fields.contact;
  return prev.full
    ? { full: true, row: { ...prev.row, ...fields } }
    : {
        full: false,
        row: { ...prev.row, ...fields },
        patched: { ...prev.patched, ...fields },
      };
}

/**
 * Fetched profile pictures applied to the open chat's contact, keeping
 * `full` as it was; `prev` itself when nothing changed.
 */
export function applyActiveAvatars(
  prev: ActiveChat | null,
  avatars: Record<string, string | null>
): ActiveChat | null {
  if (!prev) return prev;
  if (prev.full) {
    const [row] = applyAvatars([prev.row], avatars);
    return row === prev.row ? prev : { full: true, row };
  }
  const [row] = applyAvatars([prev.row], avatars);
  return row === prev.row ? prev : { ...prev, row };
}

/**
 * Waits before each retry of a missed full-row read: four reads in all,
 * over about 14 s, then `failed`.
 */
export const FULL_ROW_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10000];

/**
 * One request for a chat's full row. Compared by identity, so a re-read
 * of the same chat supersedes the earlier one's retries.
 */
export interface OpenTicket {
  readonly id: string;
}

export interface OpenConversationDeps {
  /**
   * The request made last, shared across calls: a later open or re-read
   * rewrites it, and closing the chat clears it, which is how an earlier
   * call whose read is still in flight (or waiting to retry) learns it
   * has been overtaken.
   */
  latest: { current: OpenTicket | null };
  /** Show `chat` as the open chat (a new open: the thread starts over). */
  show: (chat: ActiveChat) => void;
  /** Merge a full row into whatever is open when it lands. */
  upgrade: (full: Conversation) => void;
  /**
   * Read the full row; null when the read failed, `'gone'` when it
   * answered without the row (RLS says no). Both are retried.
   */
  fetchFull: (id: string) => Promise<Conversation | 'gone' | null>;
  /** Every retry missed for chat `id`, still the one asked for. */
  failed: (id: string) => void;
  /** Two reads running answered without chat `id`, shown and still open. */
  gone: (id: string) => void;
}

/**
 * Open chat `id`. With its list row the thread is shown before the full
 * row is even asked for, so the thread's messages read and the full-row
 * read run side by side; the full row then upgrades the open chat if it
 * is still `id`. Without a list row (a `?c=` link outside the loaded
 * list) there is nothing to show yet: the chat opens on the full row,
 * unless another open has been asked for since.
 */
export async function openConversation(
  id: string,
  listRow: ConversationListItem | undefined,
  deps: OpenConversationDeps
): Promise<void> {
  const ticket: OpenTicket = { id };
  deps.latest.current = ticket;
  if (listRow) deps.show({ full: false, row: listRow });
  await readFullRow(ticket, Boolean(listRow), deps);
}

/**
 * Read the full row again, now, for chat `id` already open on its list
 * row: the agent re-clicked it, or pressed Retry after `failed`. Any
 * retries still pending from the earlier read stop.
 */
export async function rereadFullRow(
  id: string,
  deps: OpenConversationDeps
): Promise<void> {
  const ticket: OpenTicket = { id };
  deps.latest.current = ticket;
  await readFullRow(ticket, true, deps);
}

async function readFullRow(
  ticket: OpenTicket,
  shown: boolean,
  { latest, show, upgrade, fetchFull, failed, gone }: OpenConversationDeps
): Promise<void> {
  let wasGone = false;
  for (let attempt = 0; ; attempt++) {
    const full = await fetchFull(ticket.id);
    if (full && full !== 'gone') {
      // Only the latest read lands: a superseded one (the agent re-read,
      // or left and came back) may hold an older snapshot than the read
      // that replaced it.
      if (latest.current !== ticket) return;
      if (shown) upgrade(full);
      else show({ full: true, row: full });
      return;
    }
    if (latest.current !== ticket) return;
    // Nothing shown (a link to a chat we may not see): nothing to close.
    if (shown && full === 'gone' && wasGone) {
      gone(ticket.id);
      return;
    }
    wasGone = full === 'gone';
    const delay = FULL_ROW_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      failed(ticket.id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (latest.current !== ticket) return;
  }
}
