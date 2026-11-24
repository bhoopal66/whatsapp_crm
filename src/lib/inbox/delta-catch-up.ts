// ============================================================
// The Inbox list's catch-up after a gap in realtime: read what changed
// since the watermark taken when the gap opened (pagination.ts,
// deltaWatermark) and merge it in.
//
// A window is owed until a read of it succeeds. The watermark follows
// the newest row held, so the first realtime event after a failed read
// moves it past the gap, and a new customer chat from inside the gap
// was missing until a full reload. So a failed window is kept here and
// the next read starts at the older of the two.
// ============================================================

/** Pauses before each retry of a failed catch-up read. */
export const DELTA_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];

/** The earlier of two watermarks; a missing one gives way. */
export function olderSince(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export interface DeltaCatchUp {
  /** A gap that opened at `since` has closed: read it. */
  signal: (since: string) => void;
  /** A fresh first page landed: nothing is owed any more. */
  settle: () => void;
  stop: () => void;
}

export function createDeltaCatchUp<Row>({
  read,
  apply,
  reload,
  limit,
}: {
  /** Rejects when the read failed. */
  read: (since: string) => Promise<Row[]>;
  apply: (rows: Row[]) => void;
  /** Too much changed to merge piecemeal: load the first page again. */
  reload: () => void;
  limit: number;
}): DeltaCatchUp {
  let owed: string | null = null;
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = async (since: string, mine: number, failures: number) => {
    let rows: Row[];
    try {
      rows = await read(since);
    } catch {
      if (mine !== run) return;
      const delay = DELTA_RETRY_DELAYS_MS[failures];
      // Given up: still owed, so the next signal reads this window too.
      if (delay === undefined) return;
      timer = setTimeout(() => void attempt(since, mine, failures + 1), delay);
      return;
    }
    if (mine !== run) return;
    if (rows.length >= limit) {
      // Owed until that first page lands (`settle`).
      reload();
      return;
    }
    owed = null;
    apply(rows);
  };

  const supersede = () => {
    clearTimeout(timer);
    return ++run;
  };

  return {
    signal: (since) => {
      owed = olderSince(owed, since);
      void attempt(owed!, supersede(), 0);
    },
    settle: () => {
      owed = null;
      supersede();
    },
    stop: () => {
      supersede();
    },
  };
}
