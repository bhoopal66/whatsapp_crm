import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for, with their deps kept
// across renders, as in use-thread.test.ts.
type Cell = { deps: unknown[]; value?: unknown; cleanup?: () => void };
let cells: Cell[] = [];
let at = 0;
const keep = (deps: unknown[], make: (old?: Cell) => Partial<Cell>) => {
  const old = cells[at];
  if (!old || deps.some((d, i) => d !== old.deps[i]))
    cells[at] = { deps, ...make(old) };
  return cells[at++].value;
};
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (current: unknown) => keep([], () => ({ value: { current } })),
  useCallback: (fn: unknown, deps: unknown[]) =>
    keep(deps, () => ({ value: fn })),
  useEffect: (fn: () => () => void, deps: unknown[]) =>
    keep(deps, (old) => {
      old?.cleanup?.();
      return { cleanup: fn() };
    }),
}));

const markRead = vi.fn<(sb: unknown, ch: string, at: string) => Promise<void>>(
  async () => {}
);
vi.mock('@/lib/chat', () => ({
  markRead: (sb: unknown, ch: string, at: string) => markRead(sb, ch, at),
}));

import {
  MARK_READ_DEBOUNCE_MS,
  useMarkRead,
  type MarkReadInput,
} from './use-mark-read';

const T10_00 = '2026-11-24T10:00:00.000000+00:00';
const T10_05 = '2026-11-24T10:05:00.000000+00:00';

let tab: { visibilityState: string; show?: () => void };
let channel = 0;
let base: MarkReadInput;
const ws = {
  sb: {} as never,
  userId: 'u1',
  refreshUnread: vi.fn(async () => {}) as never,
};
const Screen = (over: Partial<MarkReadInput>) =>
  useMarkRead(ws, { ...base, ...over });
/** One mounted caller of the hook; `draw` renders it again. */
function mount() {
  let mine: Cell[] = [];
  return {
    draw(over: Partial<MarkReadInput> = {}) {
      cells = mine;
      at = 0;
      const recheck = Screen(over);
      mine = cells;
      return recheck;
    },
    leave: () => mine.forEach((c) => c.cleanup?.()),
  };
}
const marked = () => markRead.mock.calls.map((c) => c[2]);
const wait = () => vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS);

beforeEach(() => {
  vi.useFakeTimers();
  markRead.mockClear();
  // A channel of its own: what was sent is remembered per channel.
  base = {
    channelId: `c${channel++}`,
    membership: { lastReadAt: null },
    at: T10_00,
    ready: true,
    mayMark: () => true,
  };
  tab = { visibilityState: 'visible' };
  vi.stubGlobal('document', {
    get visibilityState() {
      return tab.visibilityState;
    },
    addEventListener: (_e: string, fn: () => void) => void (tab.show = fn),
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useMarkRead', () => {
  it('marks up to the newest message shown, then counts again', async () => {
    mount().draw();
    expect(marked()).toEqual([]);
    await wait();
    expect(markRead).toHaveBeenCalledExactlyOnceWith(
      ws.sb,
      base.channelId,
      T10_00
    );
    expect(ws.refreshUnread).toHaveBeenCalled();
  });

  it('asks mayMark as the mark falls due, and again on a new version', async () => {
    const screen = mount();
    let fresh = true;
    const mayMark = () => fresh;
    screen.draw({ mayMark, version: 1 });
    fresh = false;
    await wait();
    expect(marked()).toEqual([]);
    fresh = true;
    screen.draw({ mayMark, version: 2 });
    await wait();
    expect(marked()).toEqual([T10_00]);
  });

  it('never goes back behind another screen of the channel', async () => {
    mount().draw({ at: T10_05 });
    await wait();
    // The mark's echo has not reached the member row yet.
    mount().draw({ at: T10_00 });
    await wait();
    expect(marked()).toEqual([T10_05]);
    // It has, and goes by the row from here on.
    const screen = mount();
    screen.draw({ at: T10_00, membership: { lastReadAt: T10_05 } });
    await wait();
    expect(marked()).toEqual([T10_05]);
    screen.draw({ at: T10_05, membership: { lastReadAt: T10_00 } });
    await wait();
    expect(marked()).toEqual([T10_05, T10_05]);
  });

  it('tries a failed mark again, still not behind the one before', async () => {
    const screen = mount();
    screen.draw({ at: T10_00 });
    await wait();
    markRead.mockRejectedValueOnce(new Error('503'));
    const recheck = screen.draw({ at: T10_05 });
    await wait();
    expect(marked()).toEqual([T10_00, T10_05]);
    mount().draw({ at: '2026-11-24T09:55:00.000000+00:00' });
    await wait();
    expect(marked()).toEqual([T10_00, T10_05]);
    recheck();
    await wait();
    expect(marked()).toEqual([T10_00, T10_05, T10_05]);
  });

  it('restarts its wait on each recheck, and marks once', async () => {
    let bottom = false;
    const recheck = mount().draw({ mayMark: () => bottom });
    await wait();
    expect(marked()).toEqual([]);
    bottom = true;
    recheck();
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS - 1);
    recheck();
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS - 1);
    expect(marked()).toEqual([]);
    await wait();
    expect(marked()).toEqual([T10_00]);
  });

  it('marks when the tab comes back into view, not while it is hidden', async () => {
    tab.visibilityState = 'hidden';
    mount().draw();
    await wait();
    expect(marked()).toEqual([]);
    tab.visibilityState = 'visible';
    tab.show?.();
    await wait();
    expect(marked()).toEqual([T10_00]);
  });

  it('does not mark after it is left', async () => {
    const screen = mount();
    screen.draw();
    screen.leave();
    await wait();
    expect(marked()).toEqual([]);
  });
});
