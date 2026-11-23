import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTableSignal } from './table-signal';

function fakeSb() {
  const s = {
    status: (status: string): void => void status,
    change: () => {},
    parts: [] as unknown[],
    removed: 0,
  };
  const ch = {
    on: (_: string, part: unknown, fn: () => void) => {
      s.parts.push(part);
      s.change = fn;
      return ch;
    },
    subscribe: (fn: (status: string) => void) => {
      s.status = fn;
      return ch;
    },
  };
  const sb = { channel: () => ch, removeChannel: () => void (s.removed += 1) };
  return { s, sb: sb as never };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('startTableSignal', () => {
  it('reads on a change, debounced, and not for the first join', async () => {
    const { s, sb } = fakeSb();
    const read = vi.fn(async () => true);
    startTableSignal(sb, 'deal_rooms:id=eq.r1|t2:room_id=eq.r1', read, true);
    expect(s.parts).toMatchObject([
      { table: 'deal_rooms', filter: 'id=eq.r1' },
      { table: 't2', filter: 'room_id=eq.r1' },
    ]);
    s.status('SUBSCRIBED');
    await later(10_000);
    expect(read).not.toHaveBeenCalled();
    s.change();
    s.change();
    await later(1_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again when the channel is back, and retries a failed read', async () => {
    const { s, sb } = fakeSb();
    const read = vi.fn(async () => false);
    startTableSignal(sb, 't:f', read, true);
    s.status('SUBSCRIBED');
    await later(10_000);
    s.status('CHANNEL_ERROR');
    s.status('SUBSCRIBED');
    await later(0);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(true);
    await later(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a bank guest gets no read beyond the changes', async () => {
    const { s, sb } = fakeSb();
    const read = vi.fn(async () => true);
    startTableSignal(sb, 't:f', read, false);
    s.status('SUBSCRIBED');
    s.status('CHANNEL_ERROR');
    s.status('SUBSCRIBED');
    await later(60_000);
    expect(read).not.toHaveBeenCalled();
  });

  it('stops with the screen', async () => {
    const { s, sb } = fakeSb();
    const read = vi.fn(async () => true);
    const stop = startTableSignal(sb, 't:f', read, true);
    s.status('SUBSCRIBED');
    s.change();
    stop();
    s.status('CHANNEL_ERROR');
    s.status('SUBSCRIBED');
    await later(60_000);
    expect(read).not.toHaveBeenCalled();
    expect(s.removed).toBe(1);
  });
});
