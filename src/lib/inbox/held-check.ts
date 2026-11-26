/**
 * Which rows the Inbox list holds are no longer ours to see. A chat
 * handed away sends no event the old holder can read and never comes
 * back in a delta, so its row stayed, with its last message, until a
 * full reload. After a delta the held ids are asked for again: RLS
 * answers with the ones still visible.
 */

/** Least time between two checks. */
export const HELD_CHECK_GAP_MS = 60_000;

/** Ids per read, so the URL stays short. */
export const HELD_CHECK_CHUNK = 150;

export interface HeldCheck {
  run: () => Promise<void>;
  stop: () => void;
}

export function createHeldCheck({
  held,
  read,
  drop,
  signedIn,
  now = Date.now,
}: {
  held: () => Iterable<string>;
  /** The ids of these still visible; rejects when the read failed. */
  read: (ids: string[]) => Promise<string[]>;
  drop: (ids: string[]) => void;
  /** Whether the same person is still signed in. */
  signedIn: () => Promise<boolean>;
  now?: () => number;
}): HeldCheck {
  let last: number | null = null;
  let stopped = false;
  return {
    async run() {
      if (stopped || (last !== null && now() - last < HELD_CHECK_GAP_MS)) {
        return;
      }
      const ids = [...held()];
      if (ids.length === 0) return;
      last = now();
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += HELD_CHECK_CHUNK) {
        chunks.push(ids.slice(i, i + HELD_CHECK_CHUNK));
      }
      const ask = async () =>
        new Set((await Promise.all(chunks.map(read))).flat());
      let visible: Set<string>;
      try {
        visible = await ask();
        // None at all is also what a lost session answers: every chat is
        // handed over only when it answers so twice, signed in.
        if (!stopped && visible.size === 0) {
          if (!(await signedIn())) return;
          visible = await ask();
        }
      } catch {
        // Unknown, so nothing goes; the next delta asks again.
        last = null;
        return;
      }
      if (stopped) return;
      const gone = ids.filter((id) => !visible.has(id));
      if (gone.length > 0) drop(gone);
    },
    stop() {
      stopped = true;
    },
  };
}
