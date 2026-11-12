import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHIME_LOCK_HOLD_MS,
  chimeLockName,
  chimeNotes,
  playAlarmChime,
} from './alarm-tone';

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
interface LockRequest {
  grant: Grant;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Exclusive Web Locks by the spec, `ifAvailable` exactly: a request that
 * finds the lock held (or others queued) is granted `null` at once and
 * never waits; any other request queues until the holder lets go.
 */
function fakeLocks() {
  const held = new Map<string, LockRequest>();
  const queues = new Map<string, LockRequest[]>();
  const queueOf = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = [];
      queues.set(name, q);
    }
    return q;
  };
  const start = (name: string, request: LockRequest) => {
    held.set(name, request);
    void Promise.resolve()
      .then(() => request.grant({}))
      .then(
        (value) => {
          held.delete(name);
          request.resolve(value);
          const next = queueOf(name).shift();
          if (next) start(name, next);
        },
        (err: unknown) => {
          held.delete(name);
          request.reject(err);
          const next = queueOf(name).shift();
          if (next) start(name, next);
        }
      );
  };
  return {
    held: (name: string) => held.has(name),
    waiting: (name: string) => queueOf(name).length,
    request: vi.fn(
      (name: string, opts: { ifAvailable?: boolean }, grant: Grant) =>
        new Promise((resolve, reject) => {
          const request = { grant, resolve, reject };
          if (!held.has(name) && queueOf(name).length === 0) {
            start(name, request);
          } else if (opts.ifAvailable) {
            void Promise.resolve()
              .then(() => grant(null))
              .then(resolve, reject);
          } else {
            queueOf(name).push(request);
          }
        })
    ),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const made = () => FakeContext.made;
const ID = 'n-1';

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

describe('chimeNotes', () => {
  it('is a rising three-note chime played twice, about 1.15 s', () => {
    const notes = chimeNotes();
    expect(notes.map((n) => n.hz)).toEqual([
      1047, 1319, 1568, 1047, 1319, 1568,
    ]);
    const last = notes[notes.length - 1];
    expect(last.atMs + last.ms).toBeGreaterThan(1000);
    expect(last.atMs + last.ms).toBeLessThanOrEqual(1300);
  });
});

describe('playAlarmChime', () => {
  it('plays the whole chime on the audio clock and closes the context after', async () => {
    playAlarmChime(ID, 0);
    await settle();
    expect(made()).toHaveLength(1);
    const { osc, close } = made()[0];
    const notes = chimeNotes();
    const last = notes[notes.length - 1];
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledTimes(notes.length);
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop.mock.calls[0][0] as number).toBeCloseTo(
      (last.atMs + last.ms) / 1000,
      1
    );
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('takes the repeat lock with ifAvailable and holds it for a while after playing', async () => {
    playAlarmChime(ID, 1);
    expect(locks.request).toHaveBeenCalledWith(
      'wacrm-reminder-chime:n-1:1',
      { ifAvailable: true },
      expect.any(Function)
    );
    expect(chimeLockName(ID, 1)).toBe('wacrm-reminder-chime:n-1:1');
    await settle();
    expect(locks.held(chimeLockName(ID, 1))).toBe(true);
    await vi.advanceTimersByTimeAsync(CHIME_LOCK_HOLD_MS - 1);
    expect(locks.held(chimeLockName(ID, 1))).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(locks.held(chimeLockName(ID, 1))).toBe(false);
  });

  it('a second tab gets no sound while the first holds the lock, then or later', async () => {
    playAlarmChime(ID, 0); // tab one
    await settle();
    playAlarmChime(ID, 0); // tab two, same alarm and repeat
    await settle();
    expect(made()).toHaveLength(1);
    expect(locks.waiting(chimeLockName(ID, 0))).toBe(0);

    // Tab two never queued, so the first tab letting go plays nothing.
    await vi.advanceTimersByTimeAsync(CHIME_LOCK_HOLD_MS * 2);
    expect(made()).toHaveLength(1);
  });

  it('the next repeat is a different lock, so it plays', async () => {
    playAlarmChime(ID, 0);
    await settle();
    playAlarmChime(ID, 1);
    await settle();
    expect(made()).toHaveLength(2);
  });

  it('plays without Web Locks', async () => {
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true } });
    playAlarmChime(ID, 0);
    await settle();
    expect(made()).toHaveLength(1);
  });

  it('a tab the browser would block takes no lock and plays nothing', async () => {
    vi.stubGlobal('navigator', {
      locks,
      userActivation: { hasBeenActive: false },
    });
    playAlarmChime(ID, 0);
    await settle();
    expect(locks.request).not.toHaveBeenCalled();
    expect(made()).toHaveLength(0);
  });

  it('never throws without audio', async () => {
    vi.stubGlobal('window', {});
    expect(() => playAlarmChime(ID, 0)).not.toThrow();
    await settle();
    expect(made()).toHaveLength(0);
  });
});
