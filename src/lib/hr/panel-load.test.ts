import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFirstLoad } from './panel-load';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(results: (string | Error)[]) {
  let i = 0;
  const read = vi.fn(async () => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
  const onData = vi.fn();
  const onState = vi.fn();
  const load = startFirstLoad(read, { onData, onState });
  return { read, onData, onState, load };
}

const boom = new Error('x');

describe('startFirstLoad', () => {
  it('delivers a first answer without retrying', async () => {
    const h = harness(['a']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.onData).toHaveBeenCalledWith('a');
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.onState).not.toHaveBeenCalled();
  });

  it('retries after 1 s, 4 s and 15 s, then reports failed', async () => {
    const h = harness([boom]);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.onState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.read).toHaveBeenCalledTimes(4);
    expect(h.onState).toHaveBeenCalledWith('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(4);
    expect(h.onData).not.toHaveBeenCalled();
  });

  it('delivers a later success', async () => {
    const h = harness([boom, 'b']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.onData).toHaveBeenCalledWith('b');
  });

  it('retry() starts over with the full delays', async () => {
    const h = harness([boom, boom, boom, boom, 'c']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.onState).toHaveBeenLastCalledWith('failed');
    h.load.retry();
    expect(h.onState).toHaveBeenLastCalledWith('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onData).toHaveBeenCalledWith('c');
  });

  it('stop() cancels a pending retry', async () => {
    const h = harness([boom, 'd']);
    await vi.advanceTimersByTimeAsync(0);
    h.load.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.onData).not.toHaveBeenCalled();
  });

  it('stop() drops an answer still in flight', async () => {
    let release: (v: string) => void = () => {};
    const onData = vi.fn();
    const load = startFirstLoad(
      () => new Promise<string>((r) => (release = r)),
      { onData, onState: vi.fn() }
    );
    load.stop();
    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).not.toHaveBeenCalled();
  });
});
