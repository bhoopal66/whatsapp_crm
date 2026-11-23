/**
 * Keeps a realtime-fed figure honest across the gaps realtime cannot
 * fill. `postgres_changes` is not replayed: what changes while a laptop
 * sleeps, Wi-Fi drops or the channel rejoins never arrives, so whoever
 * listens must read again when the channel is back.
 *
 * `startLiveRead` reads once, then again:
 *  - on every SUBSCRIBED after the first (and on a first one that came
 *    after a failed join: the opening read is as old as that outage);
 *  - when the tab is shown again after LONG_HIDE_MS hidden (a throttled
 *    background tab can miss events without a disconnect);
 *  - after a failed read, RETRY_DELAYS_MS apart, then it gives up until
 *    one of the two above. There is no polling.
 *
 * Call it in the effect that opens the channel: pass `onStatus` to
 * `subscribe`, and `stop` in the cleanup before `removeChannel`. A plain
 * function rather than a hook, because "the first SUBSCRIBED" belongs to
 * one channel and dies with it.
 */

/** Same rule as the Inbox list's (RESYNC_AFTER_HIDDEN_MS there). */
export const LONG_HIDE_MS = 30_000;

/**
 * Least time between two catch-up reads. Waking a laptop shows the tab
 * and rejoins the channel seconds apart, and a channel that keeps
 * failing rejoins every second: both fold into one read at the end.
 */
export const CATCH_UP_GAP_MS = 3_000;

export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

/** A channel not yet joined, joined, or joined / tried and lost since. */
export type ChannelState = 'new' | 'live' | 'lost';

export function channelStep(
  state: ChannelState,
  status: string
): { state: ChannelState; catchUp: boolean } {
  if (status !== 'SUBSCRIBED') return { state: 'lost', catchUp: false };
  return { state: 'live', catchUp: state !== 'new' };
}

export function hideStep(
  hiddenAt: number | null,
  visibility: string,
  now: number
): { hiddenAt: number | null; catchUp: boolean } {
  if (visibility === 'hidden') {
    return { hiddenAt: hiddenAt ?? now, catchUp: false };
  }
  return {
    hiddenAt: null,
    catchUp: hiddenAt !== null && now - hiddenAt > LONG_HIDE_MS,
  };
}

export interface LiveRead {
  /** The channel's `subscribe` callback. */
  onStatus: (status: string) => void;
  /** Read now (an event said the figure moved). */
  refresh: () => void;
  /**
   * An event, or a local write, changed the state. A read in flight may
   * have been answered before it, so it is dropped and read again
   * instead of rolling the change back.
   */
  changed: () => void;
  /** Read again after a gap the caller saw; folded like the others. */
  catchUp: () => void;
  stop: () => void;
}

export function startLiveRead<T>({
  read,
  apply,
}: {
  /** Rejects when the read failed. */
  read: () => Promise<T>;
  /** Never called after `stop`, nor once a newer read has landed. */
  apply: (value: T) => void;
}): LiveRead {
  const doc = typeof document === 'undefined' ? null : document;
  let stopped = false;
  let started = 0;
  let landed = 0;
  let changes = 0;
  let failures = 0;
  let lastStart = 0;
  let channel: ChannelState = 'new';
  let hiddenAt = doc
    ? hideStep(null, doc.visibilityState, Date.now()).hiddenAt
    : null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    clearTimeout(timer);
    const mine = ++started;
    const changesAtStart = changes;
    lastStart = Date.now();
    let value: T;
    try {
      value = await read();
    } catch {
      // A newer read is on its way: that one retries for itself.
      if (stopped || mine !== started) return;
      const delay = RETRY_DELAYS_MS[failures];
      failures += 1;
      // The timer may already hold a catch-up waiting for its gap.
      clearTimeout(timer);
      if (delay !== undefined) timer = setTimeout(() => void run(), delay);
      return;
    }
    if (stopped || mine < landed) return;
    if (changes !== changesAtStart) {
      if (mine === started) catchUp();
      return;
    }
    landed = mine;
    if (mine === started) failures = 0;
    apply(value);
  };

  function catchUp() {
    if (stopped) return;
    failures = 0;
    clearTimeout(timer);
    const wait = Math.min(
      CATCH_UP_GAP_MS,
      lastStart + CATCH_UP_GAP_MS - Date.now()
    );
    if (wait <= 0) void run();
    else timer = setTimeout(() => void run(), wait);
  }

  const onVisibility = () => {
    const step = hideStep(hiddenAt, document.visibilityState, Date.now());
    hiddenAt = step.hiddenAt;
    if (step.catchUp) catchUp();
  };

  doc?.addEventListener('visibilitychange', onVisibility);
  void run();

  return {
    onStatus: (status) => {
      if (stopped) return;
      const step = channelStep(channel, status);
      channel = step.state;
      if (step.catchUp) catchUp();
    },
    refresh: () => {
      if (stopped) return;
      failures = 0;
      void run();
    },
    changed: () => {
      changes += 1;
    },
    catchUp,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * The same, for a screen that already loads itself: nothing on start,
 * `run` after each gap. A rejecting `run` is retried as a read is.
 */
export function startCatchUp(run: () => unknown): LiveRead {
  let opened = false;
  return startLiveRead<void>({
    read: async () => {
      if (opened) await run();
      opened = true;
    },
    apply: () => {},
  });
}
