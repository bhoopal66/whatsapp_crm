import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ringNotes } from '@/lib/meetings/invite-ring';

import { LINGER_MS, holdRingSilent, startRingTone } from './invite-ring-tone';

const param = () => ({
  value: 0,
  setValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});

class FakeContext {
  static made: FakeContext[] = [];
  currentTime = 0;
  destination = {};
  osc = {
    type: '',
    frequency: param(),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    FakeContext.made.push(this);
  }
  createGain() {
    return { gain: param(), connect: vi.fn() };
  }
  createOscillator() {
    return this.osc;
  }
}

type Grant = (lock: object | null) => unknown;
interface LockOptions {
  ifAvailable?: boolean;
  signal?: AbortSignal;
  steal?: boolean;
}
interface LockRequest {
  grant: Grant;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const abortError = () =>
  Object.assign(new Error('aborted'), { name: 'AbortError' });

/** One named lock, as Web Locks treats it: held, queued for, stolen. */
function fakeLocks() {
  let holder: LockRequest | null = null;
  const queue: LockRequest[] = [];
  const free = (request: LockRequest) => {
    // Stolen: the lock is someone else's now, not this request's to free.
    if (holder !== request) return;
    holder = null;
    const next = queue.shift();
    if (next) start(next);
  };
  const start = (request: LockRequest) => {
    holder = request;
    void Promise.resolve()
      .then(() => request.grant({}))
      .then(
        (value) => {
          free(request);
          request.resolve(value);
        },
        (err: Error) => {
          free(request);
          request.reject(err);
        }
      );
  };
  return {
    get held() {
      return holder !== null;
    },
    get waiting() {
      return queue.length;
    },
    request: vi.fn(
      (_: string, opts: LockOptions, grant: Grant) =>
        new Promise((resolve, reject) => {
          const request = { grant, resolve, reject };
          if (opts.steal) {
            holder?.reject(abortError());
            start(request);
          } else if (holder && opts.ifAvailable) {
            void Promise.resolve()
              .then(() => grant(null))
              .then(resolve, reject);
          } else if (holder) {
            queue.push(request);
            opts.signal?.addEventListener('abort', () => {
              const at = queue.indexOf(request);
              if (at < 0) return;
              queue.splice(at, 1);
              reject(abortError());
            });
          } else {
            start(request);
          }
        })
    ),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const linger = () => vi.advanceTimersByTimeAsync(LINGER_MS);
const made = () => FakeContext.made;

let locks: ReturnType<typeof fakeLocks>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeContext.made = [];
  locks = fakeLocks();
  vi.stubGlobal('window', { AudioContext: FakeContext });
  vi.stubGlobal('navigator', {
    locks,
    userActivation: { hasBeenActive: true },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startRingTone', () => {
  it('rings; stopping cuts the sound at once and frees the lock a moment later', async () => {
    const stop = startRingTone();
    await settle();
    expect(made()).toHaveLength(1);
    expect(locks.held).toBe(true);

    stop();
    expect(made()[0].close).toHaveBeenCalledTimes(1);
    await settle();
    expect(locks.held).toBe(true);

    await linger();
    expect(locks.held).toBe(false);
  });

  it('lays the whole ring on the audio clock once, so it ends by itself', async () => {
    startRingTone();
    await settle();
    const { osc } = made()[0];
    const notes = ringNotes();
    const last = notes[notes.length - 1];

    expect(osc.frequency.setValueAtTime).toHaveBeenCalledTimes(notes.length);
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
    const end = osc.stop.mock.calls[0][0] as number;
    expect(end).toBeCloseTo((last.atMs + last.ms) / 1000, 1);
  });

  it('one tab rings; the next waits in line and takes over when it stops', async () => {
    const first = startRingTone();
    await settle();
    const second = startRingTone();
    await settle();
    expect(made()).toHaveLength(1);
    expect(locks.waiting).toBe(1);

    first();
    await settle();
    expect(made()).toHaveLength(1);
    await linger();
    expect(made()).toHaveLength(2);
    second();
  });

  it('a tab told to stop while it waits leaves the line and plays nothing', async () => {
    const first = startRingTone();
    await settle();
    const second = startRingTone();
    await settle();

    first();
    second();
    await linger();
    expect(made()).toHaveLength(1);
    expect(locks.held).toBe(false);
    expect(locks.waiting).toBe(0);
  });

  it('a new invite straight after the last one still rings', async () => {
    const stop = startRingTone();
    await settle();
    stop();
    const again = startRingTone();
    await linger();
    expect(made()).toHaveLength(2);
    expect(made()[1].close).not.toHaveBeenCalled();
    again();
    expect(made()[1].close).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing in a tab the browser would keep silent', async () => {
    vi.stubGlobal('navigator', {
      locks,
      userActivation: { hasBeenActive: false },
    });
    startRingTone();
    await settle();
    expect(locks.request).not.toHaveBeenCalled();
    expect(made()).toHaveLength(0);
  });

  it('never plays once stopped, even if the lock is on its way', async () => {
    let grant: Grant = () => undefined;
    locks.request.mockImplementationOnce(async (_, __, g) => {
      grant = g;
    });
    const stop = startRingTone();
    stop();
    await grant({});
    expect(made()).toHaveLength(0);
  });

  it('rings without Web Locks, and stops', () => {
    vi.stubGlobal('navigator', {});
    const stop = startRingTone();
    expect(made()).toHaveLength(1);
    stop();
    expect(made()[0].close).toHaveBeenCalledTimes(1);
  });

  it('gives up on a browser that refuses the sound, and does not retry', async () => {
    vi.stubGlobal('window', {
      AudioContext: class {
        constructor() {
          throw new Error('no audio');
        }
      },
    });
    const stop = startRingTone();
    await settle();
    expect(() => stop()).not.toThrow();
    await linger();
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(locks.held).toBe(false);
  });

  it('does not retry a lock request that failed', async () => {
    locks.request.mockRejectedValueOnce(new Error('denied'));
    startRingTone();
    await settle();
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(made()).toHaveLength(0);
  });
});

describe('holdRingSilent', () => {
  it('keeps every tab from ringing, and a waiting ring plays once it lets go', async () => {
    const letGo = holdRingSilent();
    await settle();
    const ring = startRingTone();
    await settle();
    expect(made()).toHaveLength(0);

    letGo();
    await settle();
    expect(made()).toHaveLength(1);
    ring();
  });

  it('stops a ring already going in another tab, which comes back after', async () => {
    const ring = startRingTone();
    await settle();
    const letGo = holdRingSilent();
    await settle();
    expect(made()[0].close).toHaveBeenCalledTimes(1);
    expect(locks.waiting).toBe(1);

    letGo();
    await settle();
    expect(made()).toHaveLength(2);

    ring();
    expect(made()[1].close).toHaveBeenCalledTimes(1);
    await linger();
    expect(locks.held).toBe(false);
  });

  it('a call ending and the ring starting in one tick still rings', async () => {
    const letGo = holdRingSilent();
    await settle();
    letGo();
    const ring = startRingTone();
    await settle();
    expect(made()).toHaveLength(1);
    ring();
  });

  it('a ring that ends as the call starts leaves the lock with the call', async () => {
    const ring = startRingTone();
    await settle();
    ring();
    const letGo = holdRingSilent();
    await linger();
    expect(locks.held).toBe(true);
    expect(locks.request).toHaveBeenCalledTimes(2);

    letGo();
    await settle();
    expect(locks.held).toBe(false);
  });

  it('letting go at once leaves nothing held', async () => {
    const letGo = holdRingSilent();
    letGo();
    await settle();
    expect(locks.held).toBe(false);
  });

  it('does nothing without Web Locks', () => {
    vi.stubGlobal('navigator', {});
    expect(() => holdRingSilent()()).not.toThrow();
  });
});
