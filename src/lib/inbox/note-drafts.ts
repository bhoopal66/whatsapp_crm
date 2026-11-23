import type { MentionCandidate } from './notes';

/**
 * Half-written team notes, parked per chat so a switch does not lose
 * them. Like the customer drafts: memory only (never browser storage),
 * one login's at a time (another user signing in to the tab empties
 * them), and bounded. Kept apart from the customer drafts on purpose, so
 * a note can never be restored into the customer composer. Pure.
 */
export interface NoteDraft {
  text: string;
  /** The people picked with "@". */
  picked: MentionCandidate[];
}

export const MAX_PARKED_NOTES = 50;

export interface NoteDrafts {
  read(userId: string | null, conversationId: string): NoteDraft | null;
  /** Park the draft; a blank one is dropped. */
  write(userId: string | null, conversationId: string, draft: NoteDraft): void;
  /** A save failed: put the draft back unless a newer one is there. */
  restore(
    userId: string | null,
    conversationId: string,
    draft: NoteDraft
  ): void;
  clear(userId: string | null, conversationId: string): void;
}

export function createNoteDrafts(max = MAX_PARKED_NOTES): NoteDrafts {
  let owner: string | null = null;
  const parked = new Map<string, NoteDraft>();
  /** False with nobody signed in; a different login finds it empty. */
  const claim = (userId: string | null): userId is string => {
    if (!userId) return false;
    if (owner !== userId) {
      parked.clear();
      owner = userId;
    }
    return true;
  };
  const write = (
    userId: string | null,
    conversationId: string,
    draft: NoteDraft
  ) => {
    if (!claim(userId)) return;
    // Re-inserted last, so the oldest draft is the one dropped.
    parked.delete(conversationId);
    if (draft.text.trim() === '') return;
    parked.set(conversationId, draft);
    while (parked.size > max) {
      parked.delete(parked.keys().next().value as string);
    }
  };
  return {
    read: (userId, conversationId) =>
      claim(userId) ? (parked.get(conversationId) ?? null) : null,
    write,
    restore: (userId, conversationId, draft) => {
      // A save that outlived its login must not land in the next one's.
      if (!userId || owner !== userId || parked.has(conversationId)) return;
      write(userId, conversationId, draft);
    },
    clear: (userId, conversationId) => {
      if (userId && owner === userId) parked.delete(conversationId);
    },
  };
}

/** The tab's parked notes. */
export const noteDrafts = createNoteDrafts();
