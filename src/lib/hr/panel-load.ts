/**
 * The HR panel's first read. A failed one used to read as "not tracked"
 * (the panel then offered to open a row that exists), so it is tried
 * again 1 s, 4 s and 15 s later and then reported as failed, with a
 * manual `retry()`. `read` must reject on a failed read (the caller
 * turns a Supabase `error` into a throw).
 *
 * `retry()` drops an answer still on its way and asks again, as after a
 * live row event. `stop()` ends the loader: the panel calls it when a
 * write or the catch-up read landed first, which are newer than this.
 */
export const FIRST_LOAD_DELAYS_MS = [1_000, 4_000, 15_000] as const;

export interface FirstLoad {
  /** Start over with the full set of delays; nothing once it answered. */
  retry: () => void;
  stop: () => void;
}

export function startFirstLoad<T>(
  read: () => Promise<T>,
  on: {
    onData: (value: T) => void;
    onState: (state: 'loading' | 'failed') => void;
  }
): FirstLoad {
  let stopped = false;
  let attempt = 0;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const run = async () => {
    const mine = ++generation;
    try {
      const value = await read();
      if (stopped || mine !== generation) return;
      stopped = true;
      on.onData(value);
    } catch {
      if (stopped || mine !== generation) return;
      const delay = FIRST_LOAD_DELAYS_MS[attempt++];
      if (delay === undefined) on.onState('failed');
      else timer = setTimeout(() => void run(), delay);
    }
  };

  void run();
  return {
    retry: () => {
      if (stopped) return;
      clear();
      attempt = 0;
      on.onState('loading');
      void run();
    },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
