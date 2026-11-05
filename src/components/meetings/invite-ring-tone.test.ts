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
  mode?: 'shared' | 'exclusive';
  ifAvailable?: boolean;
  signal?: AbortSignal;
  steal?: boolean;
}
interface LockRequest {
  mode: 'shared' | 'exclusive';
  grant: Grant;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}
interface NamedLock {
  held: LockRequest[];
  queue: LockRequest[];
}

const RING = 'meeting-invite-ring';
const BUSY = 'meeting-invite-busy';

const namedError = (name: string) => Object.assign(new Error(name), { name });

/** Web Locks by the spec: named, shared or exclusive, queued, stolen. */
function fakeLocks() {
  const locks = new Map<string, NamedLock>();
  const lockOf = (name: string) => {
    let lock = locks.get(name);
    if (!lock) {
      lock = { held: [], queue: [] };
      locks.set(name, lock);
    }
    return lock;
  };
  const grantable = (lock: NamedLock, mode: LockRequest['mode']) =>
    lock.held.length === 0 ||
    (mode === 'shared' && lock.held.every((h) => h.mode === 'shared'));
  const pump = (name: string) => {
    const lock = lockOf(name);
    while (lock.queue.length > 0 && grantable(lock, lock.queue[0].mode)) {
      start(name, lock.queue.shift() as LockRequest);
    }
  };
  const start = (name: string, request: LockRequest) => {
    const lock = lockOf(name);
    lock.held.push(request);
    const free = () => {
      // Stolen: it is no longer among the holders, so nothing to free.
      const at = lock.held.indexOf(request);
      if (at < 0) return;
      lock.held.splice(at, 1);
      pump(name);
    };
    void Promise.resolve()
      .then(() => request.grant({}))
      .then(
        (value) => {
          free();
          request.resolve(value);
        },
        (err: Error) => {
          free();
          request.reject(err);
        }
      );
  };
  return {
    held: (name: string) => lockOf(name).held.length,
    waiting: (name: string) => lockOf(name).queue.length,
    request: vi.fn(
      (name: string, opts: LockOptions, grant: Grant) =>
        new Promise((resolve, reject) => {
          const mode = opts.mode ?? 'exclusive';
          if (opts.steal && (mode !== 'exclusive' || opts.signal)) {
            reject(namedError('NotSupportedError'));
            return;
          }
          const lock = lockOf(name);
          const request = { mode, grant, resolve, reject };
          if (opts.steal) {
            for (const holder of lock.held.splice(0)) {
              holder.reject(namedError('AbortError'));
            }
            start(name, request);
          } else if (lock.queue.length === 0 && grantable(lock, mode)) {
            start(name, request);
          } else if (opts.ifAvailable) {
            void Promise.resolve()
              .then(() => grant(null))
              .then(resolve, reject);
          } else {
            lock.queue.push(request);
            opts.signal?.addEventListener('abort', () => {
              const at = lock.queue.indexOf(request);
              if (at < 0) return;
              lock.queue.splice(at, 1);
              reject(namedError('AbortError'));
              pump(name);
            });
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
    expect(locks.held(RING)).toBe(1);

    stop();
    expect(made()[0].close).toHaveBeenCalledTimes(1);
    await settle();
    expect(locks.held(RING)).toBe(1);

    await linger();
    expect(locks.held(RING)).toBe(0);
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
    expect(locks.waiting(RING)).toBe(1);

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
    expect(locks.held(RING)).toBe(0);
    expect(locks.waiting(RING)).toBe(0);
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
    await settle();
    expect(made()).toHaveLength(0);
  });

  it('a turn cut off before its grant ran never plays beside the next turn', async () => {
    let lateGrant: Grant = () => undefined;
    locks.request.mockImplementationOnce((_, __, grant) => {
      lateGrant = grant;
      return Promise.reject(namedError('AbortError'));
    });
    const stop = startRingTone();
    await settle();
    expect(made()).toHaveLength(1);

    await lateGrant({});
    await settle();
    expect(made()).toHaveLength(1);
    stop();
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
    expect(locks.request.mock.calls.filter(([n]) => n === RING)).toHaveLength(
      1
    );
    expect(locks.held(RING)).toBe(0);
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
    expect(made()).toHaveLength(1);

    letGo();
    await settle();
    expect(made()).toHaveLength(2);

    ring();
    expect(made()[1].close).toHaveBeenCalledTimes(1);
    await linger();
    expect(locks.held(RING)).toBe(0);
  });

  it('two tabs in calls: one ending leaves the other protected', async () => {
    const meeting = holdRingSilent();
    await settle();
    const phone = holdRingSilent();
    await settle();
    phone();
    await settle();

    const ring = startRingTone();
    await settle();
    expect(made()).toHaveLength(0);

    meeting();
    await settle();
    expect(made()).toHaveLength(1);
    ring();
  });

  it('a second tab going into a call does not let a waiting ring through', async () => {
    const meeting = holdRingSilent();
    await settle();
    const ring = startRingTone();
    await settle();
    const phone = holdRingSilent();
    await settle();
    expect(made()).toHaveLength(0);

    phone();
    await settle();
    expect(made()).toHaveLength(0);

    meeting();
    await settle();
    expect(made()).toHaveLength(1);
    ring();
  });

  it('a ring stopped while it waits for a call leaves nothing behind', async () => {
    const letGo = holdRingSilent();
    await settle();
    const ring = startRingTone();
    await settle();
    ring();
    await settle();
    expect(locks.held(RING)).toBe(0);
    expect(locks.waiting(BUSY)).toBe(0);

    letGo();
    await linger();
    expect(made()).toHaveLength(0);
    expect(locks.held(BUSY)).toBe(0);
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

  it('a ring that ends as the call starts leaves the call protected', async () => {
    const ring = startRingTone();
    await settle();
    ring();
    const letGo = holdRingSilent();
    await linger();
    expect(locks.held(BUSY)).toBe(1);
    expect(locks.held(RING)).toBe(0);

    letGo();
    await settle();
    expect(locks.held(BUSY)).toBe(0);
  });

  it('letting go at once leaves nothing held', async () => {
    const letGo = holdRingSilent();
    letGo();
    await settle();
    expect(locks.held(BUSY)).toBe(0);
    expect(locks.held(RING)).toBe(0);
  });

  it('does nothing without Web Locks', () => {
    vi.stubGlobal('navigator', {});
    expect(() => holdRingSilent()()).not.toThrow();
  });
});
