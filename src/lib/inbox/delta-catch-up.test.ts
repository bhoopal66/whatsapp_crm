import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeltaCatchUp,
  DELTA_RETRY_DELAYS_MS,
  olderSince,
} from './delta-catch-up';

const EARLY = '2026-11-24T08:00:00.000Z';
const LATE = '2026-11-24T09:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(read: (since: string) => Promise<string[]>, limit = 100) {
  const spy = vi.fn(read);
  const apply = vi.fn();
  const reload = vi.fn();
  const catchUp = createDeltaCatchUp({ read: spy, apply, reload, limit });
  return { read: spy, apply, reload, catchUp };
}

const down = () => Promise.reject(new Error('down'));

describe('olderSince', () => {
  it('is the earlier one, whatever the notation; a missing one gives way', () => {
    expect(olderSince(EARLY, LATE)).toBe(EARLY);
    expect(olderSince(LATE, EARLY)).toBe(EARLY);
    const offset = '2026-11-24T11:59:00+04:00';
    expect(olderSince(EARLY, offset)).toBe(offset);
    expect(olderSince(null, LATE)).toBe(LATE);
    expect(olderSince(EARLY, null)).toBe(EARLY);
    expect(olderSince(null, null)).toBeNull();
  });
});

describe('createDeltaCatchUp', () => {
  it('retries a failed read and merges what it then finds', async () => {
    let failing = 2;
    const t = setup(() => (failing-- > 0 ? down() : Promise.resolve(['new'])));
    t.catchUp.signal(EARLY);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.apply.mock.calls).toEqual([[['new']]]);
  });

  it('keeps a window it gave up on for the next signal', async () => {
    let up = false;
    const t = setup(() => (up ? Promise.resolve(['new']) : down()));
    t.catchUp.signal(EARLY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read).toHaveBeenCalledTimes(1 + DELTA_RETRY_DELAYS_MS.length);
    // Realtime has moved the watermark past the window since.
    up = true;
    t.catchUp.signal(LATE);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.read).toHaveBeenLastCalledWith(EARLY);
    expect(t.apply).toHaveBeenCalledTimes(1);
    // Read: no longer owed.
    t.catchUp.signal(LATE);
    expect(t.read).toHaveBeenLastCalledWith(LATE);
  });

  it('a signal during the pauses replaces the retry, window included', async () => {
    let up = false;
    const t = setup(() => (up ? Promise.resolve([]) : down()));
    t.catchUp.signal(EARLY);
    await vi.advanceTimersByTimeAsync(500);
    up = true;
    t.catchUp.signal(LATE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read.mock.calls).toEqual([[EARLY], [EARLY]]);
    expect(t.apply).toHaveBeenCalledTimes(1);
  });

  it('asks for the first page when too much changed, and owes until it lands', async () => {
    let rows = ['a', 'b'];
    const t = setup(() => Promise.resolve(rows), 2);
    t.catchUp.signal(EARLY);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.apply).not.toHaveBeenCalled();
    rows = [];
    t.catchUp.signal(LATE);
    expect(t.read).toHaveBeenLastCalledWith(EARLY);
  });

  it('a fresh first page settles it: no retry, no older window', async () => {
    const t = setup(down);
    t.catchUp.signal(EARLY);
    await vi.advanceTimersByTimeAsync(0);
    t.catchUp.settle(t.catchUp.mark());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read).toHaveBeenCalledTimes(1);
    t.catchUp.signal(LATE);
    expect(t.read).toHaveBeenLastCalledWith(LATE);
    t.catchUp.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it('a first page asked for before the gap closed settles nothing', async () => {
    let answer: (rows: string[]) => void = () => {};
    const t = setup(() => new Promise((r) => (answer = r)));
    const mark = t.catchUp.mark();
    t.catchUp.signal(EARLY);
    t.catchUp.settle(mark);
    answer(['in the gap']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.apply.mock.calls).toEqual([[['in the gap']]]);
  });

  it('a mark of one list does not settle the signal of the next', async () => {
    const a = setup(() => Promise.resolve([]));
    a.catchUp.signal(EARLY);
    const mark = a.catchUp.mark();
    const b = setup(() => Promise.resolve(['new']));
    b.catchUp.signal(EARLY);
    b.catchUp.settle(mark);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.apply.mock.calls).toEqual([[['new']]]);
  });

  it('drops an answer that a newer read has replaced', async () => {
    const answers: ((rows: string[]) => void)[] = [];
    const t = setup(() => new Promise((resolve) => answers.push(resolve)));
    t.catchUp.signal(EARLY);
    t.catchUp.signal(LATE);
    answers[0](['old']);
    answers[1](['both']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.apply.mock.calls).toEqual([[['both']]]);
  });
});
