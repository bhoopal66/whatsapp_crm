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
// contact panel) wait for `full`.
// ============================================================

/**
 * The open chat. `full: false` is a list row, shown while the full row
 * is in flight; `full: true` is the full row, after which nothing
 * downgrades it back to a list row.
 */
export type ActiveChat =
  | { full: true; row: Conversation }
  | { full: false; row: ConversationListItem };

/**
 * The full row's answer applied to the chat open *now*: it replaces the
 * row (the full row wins for every field) only if it is the same chat;
 * otherwise `prev` itself, so a slow answer for a chat the agent has
 * left never lands on the one they picked.
 */
export function applyFullRow(
  prev: ActiveChat | null,
  full: Conversation
): ActiveChat | null {
  if (!prev || prev.row.id !== full.id) return prev;
  return { full: true, row: full };
}

/**
 * A field patch (a realtime UPDATE payload, a save's result) merged into
 * the open chat when it is that chat; otherwise `prev` itself. `full`
 * is kept as it was: a patch never upgrades a list row (it does not
 * carry the full-only fields that matter) and never downgrades a full
 * row. `contact` is ignored: realtime payloads carry no join, and a
 * list row's five-column contact must not replace the full contact.
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
    : { full: false, row: { ...prev.row, ...fields } };
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
  return row === prev.row ? prev : { full: false, row };
}

export interface OpenConversationDeps {
  /**
   * The id asked for last, shared across calls: a later open rewrites
   * it, which is how an earlier call whose read is still in flight
   * learns it has been overtaken.
   */
  latest: { current: string | null };
  /** Show `chat` as the open chat (a new open: the thread starts over). */
  show: (chat: ActiveChat) => void;
  /** Merge a full row into whatever is open when it lands. */
  upgrade: (full: Conversation) => void;
  /** Read the full row; null when RLS says no or the read failed. */
  fetchFull: (id: string) => Promise<Conversation | null>;
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
  { latest, show, upgrade, fetchFull }: OpenConversationDeps
): Promise<void> {
  latest.current = id;
  if (listRow) show({ full: false, row: listRow });
  const full = await fetchFull(id);
  if (!full) return;
  if (listRow) {
    upgrade(full);
    return;
  }
  if (latest.current !== id) return;
  show({ full: true, row: full });
}
