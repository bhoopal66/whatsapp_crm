import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_TAKE_MS,
  STOP_TIMEOUT_MS,
  TakeRecorder,
  micProblem,
  type MicProblem,
  type RecordedTake,
  type RecorderLike,
  type RecordingPhase,
} from './take-recorder';

interface Meta {
  chat: string;
  to?: string;
}

/** A recorder that behaves as opus-recorder does: see take-recorder.ts. */
class FakeRecorder implements RecorderLike {
  ondataavailable: ((bytes: Uint8Array) => void) | null = null;
  state: 'inactive' | 'loading' | 'recording' = 'inactive';
  micOpen = false;
  closed = 0;
  bytes = new Uint8Array([1, 2, 3]);
  opened!: () => void;
  refused!: (err: unknown) => void;
  hang = false;

  start() {
    this.state = 'loading';
    return new Promise<void>((resolve, reject) => {
      this.opened = () => {
        this.state = 'recording';
        this.micOpen = true;
        resolve();
      };
      this.refused = (err) => {
        this.state = 'inactive';
        reject(err);
      };
    });
  }

  async stop() {
    // While loading it does nothing at all.
    if (this.state !== 'recording') return;
    this.state = 'inactive';
    this.micOpen = false;
    if (this.hang) return new Promise<void>(() => {});
    await Promise.resolve();
    this.ondataavailable?.(this.bytes);
  }

  async close() {
    this.closed++;
    this.micOpen = false;
  }
}

function setup() {
  const made: FakeRecorder[] = [];
  const phases: RecordingPhase[] = [];
  const takes: RecordedTake<Meta>[] = [];
  const problems: MicProblem[] = [];
  let clock = 1000;
  let next: (() => Promise<FakeRecorder>) | null = null;
  const rec = new TakeRecorder<Meta, FakeRecorder>({
    create: async () => {
      if (next) return next();
      const r = new FakeRecorder();
      made.push(r);
      return r;
    },
    now: () => clock,
    onPhase: (p) => phases.push(p),
    onTake: (t) => takes.push(t),
    onProblem: (p) => problems.push(p),
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const open = async (meta: Meta = { chat: 'a' }) => {
    const started = rec.start(meta);
    await flush();
    made.at(-1)!.opened();
    return started;
  };
  return {
    rec,
    made,
    phases,
    takes,
    problems,
    flush,
    open,
    wait: (ms: number) => {
      clock += ms;
    },
    create: (fn: () => Promise<FakeRecorder>) => {
      next = fn;
    },
  };
}

describe('TakeRecorder', () => {
  it('hands over the file with what was pressed, and closes the mic', async () => {
    const h = setup();
    expect(await h.open({ chat: 'a' })).toBe(true);
    expect(h.rec.live).toBe(h.made[0]);
    h.wait(4200);
    expect(h.rec.elapsedMs()).toBe(4200);
    expect(h.rec.finish('send', { to: 'x' })).toBe(true);
    expect(h.made[0].micOpen).toBe(false);
    await h.flush();
    expect(h.takes).toEqual([
      {
        bytes: h.made[0].bytes,
        durationMs: 4200,
        intent: 'send',
        meta: { chat: 'a', to: 'x' },
      },
    ]);
    expect(h.made[0].closed).toBe(1);
    expect(h.phases).toEqual(['starting', 'recording', 'finishing', 'idle']);
    expect(h.problems).toEqual([]);
    expect(h.rec.live).toBeNull();
  });

  it('can be listened to first, and records again afterwards', async () => {
    const h = setup();
    await h.open();
    h.wait(2000);
    expect(h.rec.finish('review')).toBe(true);
    await h.flush();
    expect(h.takes[0].intent).toBe('review');
    expect(await h.open({ chat: 'b' })).toBe(true);
    expect(h.made).toHaveLength(2);
  });

  it('is not ended by the second tap of a double tap on the mic', async () => {
    const h = setup();
    await h.open();
    h.wait(MIN_TAKE_MS - 1);
    expect(h.rec.finish('send')).toBe(false);
    expect(h.rec.phase).toBe('recording');
    h.wait(1);
    expect(h.rec.finish('send')).toBe(true);
  });

  it('opens one microphone, however often the mic is pressed', async () => {
    const h = setup();
    const first = h.rec.start({ chat: 'a' });
    expect(await h.rec.start({ chat: 'a' })).toBe(false);
    await h.flush();
    h.made[0].opened();
    expect(await first).toBe(true);
    expect(await h.rec.start({ chat: 'a' })).toBe(false);
    expect(h.made).toHaveLength(1);
  });

  it('sends once, however often Send is pressed', async () => {
    const h = setup();
    await h.open();
    h.wait(2000);
    expect(h.rec.finish('send')).toBe(true);
    expect(h.rec.finish('send')).toBe(false);
    await h.flush();
    expect(h.takes).toHaveLength(1);
  });

  it('cancelled while the browser still asks: the mic is freed when it opens', async () => {
    const h = setup();
    const started = h.rec.start({ chat: 'a' });
    await h.flush();
    h.rec.cancel();
    expect(h.rec.phase).toBe('idle');
    h.made[0].opened();
    expect(await started).toBe(false);
    await h.flush();
    expect(h.made[0].micOpen).toBe(false);
    expect(h.made[0].closed).toBe(1);
    expect(h.takes).toEqual([]);
    expect(h.problems).toEqual([]);
  });

  it('cancelled while the encoder loads: the mic is never asked for', async () => {
    const h = setup();
    const r = new FakeRecorder();
    let loaded!: (r: FakeRecorder) => void;
    h.create(() => new Promise((resolve) => (loaded = resolve)));
    const started = h.rec.start({ chat: 'a' });
    h.rec.cancel();
    loaded(r);
    expect(await started).toBe(false);
    await h.flush();
    expect(r.state).toBe('inactive');
    expect(r.closed).toBe(1);
  });

  it('a cancelled take never comes back', async () => {
    const h = setup();
    await h.open();
    h.wait(5000);
    h.rec.cancel();
    await h.flush();
    expect(h.made[0].micOpen).toBe(false);
    expect(h.takes).toEqual([]);
    expect(h.phases).toEqual(['starting', 'recording', 'idle']);
  });

  it('a late file of a cancelled take does not land in the next one', async () => {
    const h = setup();
    await h.open({ chat: 'a' });
    h.wait(1000);
    h.rec.cancel();
    await h.open({ chat: 'b' });
    h.made[0].ondataavailable?.(new Uint8Array([9]));
    expect(h.takes).toEqual([]);
    expect(h.rec.phase).toBe('recording');
  });

  it('says why the mic did not open, frees it, and can be tried again', async () => {
    const h = setup();
    const started = h.rec.start({ chat: 'a' });
    await h.flush();
    h.made[0].refused(
      Object.assign(new Error('no'), { name: 'NotAllowedError' })
    );
    expect(await started).toBe(false);
    await h.flush();
    expect(h.problems).toEqual(['blocked']);
    expect(h.rec.phase).toBe('idle');
    expect(h.made[0].closed).toBe(1);
    expect(await h.open()).toBe(true);
  });

  it('says so when the encoder cannot be loaded', async () => {
    const h = setup();
    h.create(() => Promise.reject(new Error('chunk')));
    expect(await h.rec.start({ chat: 'a' })).toBe(false);
    expect(h.problems).toEqual(['failed']);
    expect(h.rec.phase).toBe('idle');
  });

  it('says so when the recording gave no file', async () => {
    const h = setup();
    await h.open();
    h.made[0].bytes = new Uint8Array();
    h.wait(3000);
    h.rec.finish('send');
    await h.flush();
    expect(h.takes).toEqual([]);
    expect(h.problems).toEqual(['lost']);
    expect(h.rec.phase).toBe('idle');
  });

  describe('an encoder that never answers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not hold the composer', async () => {
      const h = setup();
      await h.open();
      h.made[0].hang = true;
      h.wait(3000);
      h.rec.finish('send');
      await h.flush();
      expect(h.rec.phase).toBe('finishing');
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
      expect(h.rec.phase).toBe('idle');
      expect(h.problems).toEqual(['lost']);
      expect(h.made[0].closed).toBe(1);
    });
  });

  describe('leaving the chat', () => {
    it('ends the take, to be listened to', async () => {
      const h = setup();
      await h.open();
      h.wait(3000);
      h.rec.leave();
      await h.flush();
      expect(h.takes.map((t) => t.intent)).toEqual(['review']);
    });

    it('drops one that had only just begun, or not yet', async () => {
      const h = setup();
      await h.open();
      h.wait(100);
      h.rec.leave();
      expect(h.rec.phase).toBe('idle');
      const started = h.rec.start({ chat: 'a' });
      await h.flush();
      h.rec.leave();
      h.made[1].opened();
      expect(await started).toBe(false);
      await h.flush();
      expect(h.takes).toEqual([]);
      expect(h.made.map((r) => r.micOpen)).toEqual([false, false]);
    });

    it('does not take back one that was sent', async () => {
      const h = setup();
      await h.open();
      h.wait(3000);
      h.rec.finish('send');
      h.rec.leave();
      await h.flush();
      expect(h.takes.map((t) => t.intent)).toEqual(['send']);
    });
  });

  describe('the composer going away', () => {
    it('drops a take that was not sent', async () => {
      const h = setup();
      await h.open();
      h.wait(3000);
      h.rec.dispose();
      await h.flush();
      expect(h.takes).toEqual([]);
      expect(h.made[0].micOpen).toBe(false);
    });

    it('drops one that was to be listened to', async () => {
      const h = setup();
      await h.open();
      h.wait(3000);
      h.rec.finish('review');
      h.rec.dispose();
      await h.flush();
      expect(h.takes).toEqual([]);
    });

    it('still sends one that was sent', async () => {
      const h = setup();
      await h.open();
      h.wait(3000);
      h.rec.finish('send');
      h.rec.dispose();
      await h.flush();
      expect(h.takes.map((t) => t.intent)).toEqual(['send']);
    });

    it('is harmless with nothing recorded', () => {
      const h = setup();
      h.rec.dispose();
      h.rec.leave();
      h.rec.cancel();
      expect(h.phases).toEqual([]);
    });
  });
});

describe('micProblem', () => {
  it.each([
    ['NotAllowedError', 'blocked'],
    ['SecurityError', 'blocked'],
    ['NotFoundError', 'missing'],
    ['OverconstrainedError', 'missing'],
    ['NotReadableError', 'inUse'],
    ['AbortError', 'failed'],
    ['TypeError', 'failed'],
  ])('%s is %s', (name, problem) => {
    expect(micProblem(Object.assign(new Error('x'), { name }))).toBe(problem);
  });

  it('is failed for anything else', () => {
    expect(micProblem(undefined)).toBe('failed');
    expect(micProblem('NotAllowedError')).toBe('failed');
  });
});
