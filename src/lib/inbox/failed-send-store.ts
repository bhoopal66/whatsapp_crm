import type { FailedSend } from './failed-send';

/**
 * The unsent replies of every chat, in memory for the life of the tab.
 * Outside the thread component, so leaving the inbox (also while a send
 * is in flight) keeps them; never on disk, and never shown to another
 * login on the same tab: `claim` empties it.
 */
export function createFailedSendStore<T = FailedSend>() {
  let rows: readonly T[] = [];
  let owner: string | null = null;
  let threads = 0;
  const listeners = new Set<() => void>();

  const set = (next: readonly T[]) => {
    rows = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => rows,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The login whose rows these are. Returns another login's, dropped. */
    claim: (userId: string): readonly T[] => {
      if (owner === userId) return [];
      const dropped = rows;
      owner = userId;
      if (dropped.length > 0) set([]);
      return dropped;
    },
    /** False when another login holds the store by now: nothing is kept. */
    add: (userId: string | null, row: T): boolean => {
      if (!userId || userId !== owner) return false;
      set([...rows, row]);
      return true;
    },
    remove: (gone: readonly T[]): void => {
      if (gone.length > 0) set(rows.filter((f) => !gone.includes(f)));
    },
    /** A thread is on screen until the returned function runs. */
    enter: () => {
      threads += 1;
      return () => {
        threads -= 1;
      };
    },
    /** No thread on screen: the person has left the inbox. */
    left: () => threads === 0,
  };
}

export const failedSendStore = createFailedSendStore();
