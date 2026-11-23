import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for, as in
// live-read-wiring.test.tsx; an effect runs at once.
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [init, () => {}],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
}));
let status: ((s: string) => void) | undefined;
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = {
      on: () => ch,
      subscribe: (fn: typeof status) => ((status = fn), ch),
    };
    return { channel: () => ch, removeChannel: () => {} };
  },
}));

import { useDealRooms, useScopedDealRooms } from './use-deal-rooms';

const read = vi.fn<() => Promise<Response>>();
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const rejoin = async () => {
  status?.('CHANNEL_ERROR');
  status?.('SUBSCRIBED');
  await later(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset();
  read.mockImplementation(async () => Response.json({ rooms: [] }));
  vi.stubGlobal('fetch', read);
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the deal room lists after a gap', () => {
  it.each([
    ['all rooms', () => useDealRooms('acc')],
    ["a contact's rooms", () => useScopedDealRooms({ contactId: 'c1' })],
  ])('%s: read again, and again when that read failed', async (_n, mount) => {
    mount();
    status?.('SUBSCRIBED');
    await later(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error('offline'));
    await rejoin();
    expect(read).toHaveBeenCalledTimes(2);
    await later(30_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('a bank guest keeps to the minute refresh', async () => {
    useDealRooms('acc', true);
    status?.('SUBSCRIBED');
    await later(10_000);
    await rejoin();
    await later(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    await later(30_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('the room screen', () => {
  const src = readFileSync('src/components/deal-rooms/room-view.tsx', 'utf8');

  it('leaves the room itself to the minute refresh for a bank guest', () => {
    expect(src).toMatch(
      /roomSignalFilter\(table, roomId\),\s+reload,\s+!isBankGuest\s+\)/
    );
  });

  it('shows a failed first read as one, with Try again', () => {
    expect(src).toMatch(/phase === 'failed'\) \{\s+return \(\s+<LoadFailed/);
    // What says so to the catch-up, which then tries again.
    expect(src).toMatch(/setTimeline\(log\.state\(\)\);\s+return ok;/);
  });
});
