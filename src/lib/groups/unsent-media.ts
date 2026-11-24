import { createUnsentTakes } from '@/lib/inbox/unsent-takes';

/**
 * What a group refused, kept to be offered again: uploaded files by
 * chat, oldest first, in memory only, one login's at a time (the rules
 * of `createUnsentTakes`). They outlive the composer.
 */
export interface UnsentQueue<T> {
  claim(userId: string | null): void;
  first(userId: string | null, key: string): T | null;
  /** The first one, no longer kept. */
  take(userId: string | null, key: string): T | null;
  /** False when another login has the tab since: nothing is kept. */
  add(userId: string | null, key: string, item: T): boolean;
  subscribe(listener: () => void): () => void;
}

export function createUnsentQueue<T>(): UnsentQueue<T> {
  const store = createUnsentTakes<readonly T[]>();
  const all = (userId: string | null, key: string) =>
    store.get(userId, key) ?? [];
  return {
    claim: store.claim,
    first: (userId, key) => all(userId, key)[0] ?? null,
    take(userId, key) {
      const [first, ...rest] = all(userId, key);
      if (first === undefined) return null;
      if (rest.length > 0) store.put(userId, key, rest);
      else store.remove(key);
      return first;
    },
    add: (userId, key, item) =>
      store.put(userId, key, [...all(userId, key), item]),
    subscribe: store.subscribe,
  };
}

/** Where a send the group refused goes. Each answers whether it took it. */
export interface RefusedSend<T> {
  /** Back in the composer: only while it is on screen and empty. */
  toComposer: (staged: T) => boolean;
  /** The recording itself, to be sent again: only for one just made. */
  keepRecording: () => boolean;
  /** The uploaded file, offered when the chat is opened again. */
  keepUpload: (staged: T) => boolean;
  /** Nobody is left to offer it to. */
  remove: (staged: T) => void;
  /** Kept, but not in sight. */
  onKept: () => void;
}

/**
 * Sends what is uploaded. Not sent, it is never thrown away while the
 * person who made it can still send it: the composer gives it back, or,
 * the chat left meanwhile, it waits there.
 */
export async function sendOrKeep<T>(
  staged: T,
  deliver: (staged: T) => Promise<boolean>,
  refused: RefusedSend<T>
): Promise<void> {
  try {
    if (await deliver(staged)) return;
  } catch {
    // Not sent.
  }
  if (refused.toComposer(staged)) return;
  if (refused.keepRecording()) {
    // Uploaded anew when it is sent again.
    refused.remove(staged);
  } else if (!refused.keepUpload(staged)) {
    refused.remove(staged);
    return;
  }
  refused.onKept();
}
