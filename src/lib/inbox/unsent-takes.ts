/**
 * Voice notes whose upload failed, kept to be tried again: one per chat,
 * in memory only (never browser storage), one login's at a time. They
 * outlive the composer, so leaving the chat and coming back finds them.
 * Pure, with `useSyncExternalStore` in mind: `get` changes nothing.
 */
export interface UnsentTakes<T> {
  /** Who is signed in: another login finds it empty. */
  claim(userId: string | null): void;
  get(userId: string | null, key: string): T | null;
  /** False when another login has the tab since: nothing is kept. */
  put(userId: string | null, key: string, take: T): boolean;
  remove(key: string): void;
  subscribe(listener: () => void): () => void;
}

export function createUnsentTakes<T>(): UnsentTakes<T> {
  let owner: string | null = null;
  const takes = new Map<string, T>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    claim(userId) {
      if (!userId || userId === owner) return;
      owner = userId;
      if (takes.size === 0) return;
      takes.clear();
      changed();
    },
    get: (userId, key) =>
      userId && userId === owner ? (takes.get(key) ?? null) : null,
    put(userId, key, take) {
      if (!userId || userId !== owner) return false;
      takes.set(key, take);
      changed();
      return true;
    },
    remove(key) {
      if (takes.delete(key)) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
