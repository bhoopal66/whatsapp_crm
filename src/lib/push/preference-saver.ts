/**
 * Saves the notification settings after a short pause, one request at a
 * time: what was changed while one is under way goes out when it has
 * answered, latest only, so an older save never lands on a newer one.
 * Pure: the panel supplies the request.
 */
export interface PreferenceSaver<T> {
  /** Save this after the pause, instead of anything not sent yet. */
  schedule(body: T): void;
  /** The panel is closing: send what is waiting now, outliving the page. */
  flush(): void;
  /** The page itself is closing: as flush, without queueing for a save under way. */
  flushNow(): void;
}

export function createPreferenceSaver<T>({
  send,
  delayMs,
}: {
  /** PUT the body; must not reject. */
  send: (body: T, opts: { keepalive: boolean }) => Promise<void>;
  delayMs: number;
}): PreferenceSaver<T> {
  let waiting: { body: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let closing = false;

  const go = async (force = false) => {
    clearTimeout(timer);
    if (!waiting || (sending && !force)) return;
    const { body } = waiting;
    waiting = null;
    sending = true;
    try {
      await send(body, { keepalive: closing });
    } catch {
      // `send` reports its own failures; the next save must still go out.
    } finally {
      sending = false;
    }
    // Changed while that was under way (its pause may still be running).
    if (waiting) await go();
  };

  return {
    schedule(body) {
      waiting = { body };
      closing = false;
      clearTimeout(timer);
      timer = setTimeout(() => void go(), delayMs);
    },
    flush() {
      closing = true;
      void go();
    },
    flushNow() {
      closing = true;
      void go(true);
    },
  };
}
