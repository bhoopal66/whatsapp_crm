import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ringNotes } from '@/lib/meetings/invite-ring';

import { holdRingSilent, startRingTone } from './invite-ring-tone';

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
}

/** One named lock, as Web Locks treats it: held, or queued for. */
function fakeLocks() {
  let held = false;
  const queue: (() => void)[] = [];
  const release = () => {
    held = false;
    queue.shift()?.();
  };
  const run = async (grant: Grant) => {
    held = true;
    try {
      await grant({});
    } finally {
      release();
    }
  };
  return {
    get held() {
      return held;
    },
    request: vi.fn(async (_: string, opts: LockOptions, grant: Grant) => {
      if (!held) return run(grant);
      if (opts.ifAvailable) return grant(null);
      return new Promise<void>((resolve, reject) => {
        const turn = () => void run(grant).then(resolve);
        queue.push(turn);
        opts.signal?.addEventListener('abort', () => {
          queue.splice(queue.indexOf(turn), 1);
          reject(new Error('aborted'));
        });
      });
    }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let locks: ReturnType<typeof fakeLocks>;

beforeEach(() => {
  FakeContext.made = [];
  locks = fakeLocks();
  vi.stubGlobal('window', { AudioContext: FakeContext });
  vi.stubGlobal('navigator', {
    locks,
    userActivation: { hasBeenActive: true },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startRingTone', () => {
  it('takes the lock and rings; stopping closes the sound and frees the lock', async () => {
    const stop = startRingTone();
    await settle();
    expect(FakeContext.made).toHaveLength(1);
    expect(locks.held).toBe(true);

    stop();
    await settle();
    expect(FakeContext.made[0].close).toHaveBeenCalledTimes(1);
    expect(locks.held).toBe(false);
  });

  it('lays the whole ring on the audio clock once, so it ends by itself', async () => {
    startRingTone();
    await settle();
    const { osc } = FakeContext.made[0];
    const notes = ringNotes();
    const last = notes[notes.length - 1];

    expect(osc.frequency.setValueAtTime).toHaveBeenCalledTimes(notes.length);
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
    const end = osc.stop.mock.calls[0][0] as number;
    expect(end).toBeCloseTo((last.atMs + last.ms) / 1000, 1);
  });

  it('stays silent when another tab already rings', async () => {
    const first = startRingTone();
    await settle();
    const second = startRingTone();
    await settle();
    expect(FakeContext.made).toHaveLength(1);
    second();
    await settle();
    expect(locks.held).toBe(true);
    first();
  });

  it('asks for nothing in a tab the browser would keep silent', async () => {
    vi.stubGlobal('navigator', {
      locks,
      userActivation: { hasBeenActive: false },
    });
    startRingTone();
    await settle();
    expect(locks.request).not.toHaveBeenCalled();
    expect(FakeContext.made).toHaveLength(0);
  });

  it('never plays once stopped, even if the lock comes later', async () => {
    const hold = holdRingSilent();
    await settle();
    // Queued by hand: a real ring asks with ifAvailable, so only a slow
    // grant can land after its stop.
    let grant: Grant = () => undefined;
    locks.request.mockImplementationOnce(async (_, __, g) => {
      grant = g;
    });
    const stop = startRingTone();
    stop();
    await grant({});
    expect(FakeContext.made).toHaveLength(0);
    hold();
  });

  it('rings without Web Locks, and stops', async () => {
    vi.stubGlobal('navigator', {});
    const stop = startRingTone();
    expect(FakeContext.made).toHaveLength(1);
    stop();
    await settle();
    expect(FakeContext.made[0].close).toHaveBeenCalledTimes(1);
  });

  it('survives a browser that refuses the sound', async () => {
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
    expect(locks.held).toBe(false);
  });
});

describe('holdRingSilent', () => {
  it('keeps every other tab from ringing until it lets go', async () => {
    const letGo = holdRingSilent();
    await settle();
    startRingTone();
    await settle();
    expect(FakeContext.made).toHaveLength(0);

    letGo();
    await settle();
    expect(locks.held).toBe(false);
    startRingTone();
    await settle();
    expect(FakeContext.made).toHaveLength(1);
  });

  it('waits its turn behind a ring, and can give up while it waits', async () => {
    const stopRing = startRingTone();
    await settle();
    const letGo = holdRingSilent();
    await settle();
    letGo();
    stopRing();
    await settle();
    expect(locks.held).toBe(false);
  });

  it('takes the lock when a ring ends while it waits', async () => {
    const stopRing = startRingTone();
    await settle();
    const letGo = holdRingSilent();
    await settle();
    stopRing();
    await settle();
    expect(locks.held).toBe(true);
    letGo();
    await settle();
    expect(locks.held).toBe(false);
  });

  it('does nothing without Web Locks', () => {
    vi.stubGlobal('navigator', {});
    expect(() => holdRingSilent()()).not.toThrow();
  });
});
