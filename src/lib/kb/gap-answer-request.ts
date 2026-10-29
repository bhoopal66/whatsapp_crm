/**
 * The "Write an approved answer" hand-off between the knowledge-gap
 * Topics view (Knowledge tab) and the approved-answers editor (Answers
 * tab). The gaps card creates a draft row (`POST /api/ai/kb`), the AI
 * Agents area carries it across as a request, and the editor opens its
 * dialog on that row. A draft the person closes without saving is
 * deleted again, so a cancelled hand-off leaves nothing behind.
 *
 * Pure and dependency-free: both ends are client components.
 */

/** A request to open the editor on a freshly created draft. */
export interface GapAnswerRequest<E extends { id: string }> {
  entry: E;
  /** Bumped per request, so the same row asked for twice opens twice. */
  nonce: number;
}

/** The next request, its nonce one past the previous one's. */
export function nextGapAnswerRequest<E extends { id: string }>(
  previous: GapAnswerRequest<E> | null,
  entry: E
): GapAnswerRequest<E> {
  return { entry, nonce: (previous?.nonce ?? 0) + 1 };
}

/**
 * The editor's list with the requested row in it: the row is new, so
 * the list loaded before it was created lacks it. An existing row with
 * the same id is kept as loaded (it is the fresher read).
 */
export function withRequestedEntry<E extends { id: string }>(
  entries: readonly E[],
  entry: E
): E[] {
  return entries.some((e) => e.id === entry.id)
    ? [...entries]
    : [entry, ...entries];
}

/**
 * Which draft to delete when the editor dialog closes without a save:
 * the hand-off's draft, and only when it is the row that just closed.
 * A save, a delete or a stale-row reload clears the pending id first,
 * so none of those ever reaches here with it set.
 */
export function draftToDiscard(
  pendingDraftId: string | null,
  closedEntryId: string | null
): string | null {
  return pendingDraftId !== null && pendingDraftId === closedEntryId
    ? pendingDraftId
    : null;
}
