import { holdUnsaved } from '@/lib/app-update/unsaved';

/**
 * What is typed in a group chat's box, by chat: the box reads it from
 * here, so leaving the chat and coming back finds it, and words a group
 * refused after the chat was left come back to it. The rules of
 * `createNoteDrafts`: memory only (never browser storage), one login's
 * at a time (another user signing in to the tab empties them), bounded.
 * Pure, with `useSyncExternalStore` in mind: `get` changes nothing.
 */
export interface TextDrafts {
  /** Who is signed in: another login finds it empty. */
  claim(userId: string | null): void;
  /** '' when there is none. */
  get(userId: string | null, key: string): string;
  /** What the box holds now; empty drops it. */
  write(userId: string | null, key: string, text: string): void;
  /** A send failed: the words come back unless others are there. */
  restore(userId: string | null, key: string, text: string): void;
  /** Whether words are kept at all. */
  any(): boolean;
  subscribe(listener: () => void): () => void;
}

export const MAX_TEXT_DRAFTS = 50;

export function createTextDrafts(max = MAX_TEXT_DRAFTS): TextDrafts {
  let owner: string | null = null;
  const drafts = new Map<string, string>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const claim = (userId: string | null) => {
    if (!userId || userId === owner) return;
    owner = userId;
    if (drafts.size === 0) return;
    drafts.clear();
    changed();
  };
  const get = (userId: string | null, key: string) =>
    userId && userId === owner ? (drafts.get(key) ?? '') : '';
  const put = (key: string, text: string) => {
    // Re-inserted last, so the oldest draft is the one dropped.
    drafts.delete(key);
    if (text) drafts.set(key, text);
    while (drafts.size > max) {
      drafts.delete(drafts.keys().next().value as string);
    }
    changed();
  };
  return {
    claim,
    get,
    write(userId, key, text) {
      if (!userId) return;
      claim(userId);
      put(key, text);
    },
    restore(userId, key, text) {
      // A send that outlived its login must not land in the next one's.
      if (!userId || owner !== userId || get(userId, key).trim()) return;
      put(key, text);
    },
    any: () => [...drafts.values()].some((text) => text.trim() !== ''),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Sends what is typed. It leaves the box at once (coming back meanwhile
 * must not offer words that may be sent), and comes back if it was not
 * sent, whether the chat is still open or not.
 */
export async function sendTyped(
  drafts: TextDrafts,
  userId: string | null,
  key: string,
  send: (body: string) => Promise<boolean>
): Promise<void> {
  const body = drafts.get(userId, key).trim();
  if (!body) return;
  drafts.write(userId, key, '');
  let sent = false;
  try {
    sent = await send(body);
  } finally {
    if (!sent) drafts.restore(userId, key, body);
  }
}

/** The tab's group drafts. */
export const groupTextDrafts = createTextDrafts();
// They die with the tab: no reload by itself while one waits.
holdUnsaved(() => groupTextDrafts.any());
