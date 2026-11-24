import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CATCH_UP_GAP_MS,
  LONG_HIDE_MS,
  RETRY_DELAYS_MS,
} from '@/lib/realtime/catch-up';

import { joinFreshPage, oldestStored, startChatCatchUp } from './live-chat';

const row = (n: number, extra: { id?: string } = {}) => ({
  id: `m${n}`,
  created_at: new Date(Date.UTC(2026, 10, 23, 9, n)).toISOString(),
  ...extra,
});
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
const ids = (log: { messages: { id: string }[] }) =>
  log.messages.map((m) => m.id);

describe('oldestStored', () => {
  it('is never a send on its way: the server has no such row', () => {
    expect(oldestStored([row(1, { id: 'tmp-1' }), row(2), row(3)])?.id).toBe(
      'm2'
    );
    expect(oldestStored([row(1, { id: 'tmp-1' })])).toBeUndefined();
  });
});

describe('joinFreshPage', () => {
  it('is the page on a first load', () => {
    const page = { messages: rows(1, 3), hasMore: true };
    expect(joinFreshPage({ messages: [], hasMore: false }, page)).toEqual(page);
  });

  it('joins a page that reaches back into what is held', () => {
    const log = joinFreshPage(
      { messages: rows(1, 5), hasMore: true },
      { messages: rows(4, 7), hasMore: true }
    );
    expect(ids(log)).toEqual(ids({ messages: rows(1, 7) }));
    expect(log.hasMore).toBe(true);
  });

  it('keeps knowing that the start of the log is held', () => {
    expect(
      joinFreshPage(
        { messages: rows(1, 5), hasMore: false },
        { messages: rows(4, 7), hasMore: true }
      ).hasMore
    ).toBe(false);
  });

  it('replaces what is held when messages are missing in between', () => {
    const log = joinFreshPage(
      { messages: rows(1, 5), hasMore: false },
      { messages: rows(10, 12), hasMore: true }
    );
    expect(ids(log)).toEqual(['m10', 'm11', 'm12']);
    expect(log.hasMore).toBe(true);
  });

  it('is not fooled by a message that arrived after the gap', () => {
    const log = joinFreshPage(
      { messages: [...rows(1, 5), row(12)], hasMore: false },
      { messages: rows(10, 12), hasMore: true }
    );
    expect(ids(log)).toEqual(['m10', 'm11', 'm12']);
  });

  it('keeps a send on its way, and what arrived during the read', () => {
    const log = joinFreshPage(
      {
        messages: [...rows(1, 5), row(6, { id: 'tmp-1' }), row(13)],
        hasMore: true,
      },
      { messages: rows(10, 12), hasMore: true }
    );
    expect(ids(log)).toEqual(['tmp-1', 'm10', 'm11', 'm12', 'm13']);
  });

  it('joins a page that is the whole log', () => {
    expect(
      joinFreshPage(
        { messages: [row(9, { id: 'tmp-1' })], hasMore: true },
        { messages: rows(1, 3), hasMore: false }
      )
    ).toEqual({
      messages: [...rows(1, 3), row(9, { id: 'tmp-1' })],
      hasMore: false,
    });
  });
});

describe('startChatCatchUp', () => {
  let visibility = 'visible';
  const doc = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  const win = new EventTarget();
  const show = (state: string) => {
    visibility = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  const refresh = vi.fn<() => Promise<boolean>>();
  const settle = vi.fn<(due: boolean) => void>();
  let live: ReturnType<typeof startChatCatchUp>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    visibility = 'visible';
    refresh.mockReset().mockResolvedValue(true);
    settle.mockReset();
    live = startChatCatchUp({ refresh, settle });
    live.onStatus('SUBSCRIBED');
  });
  afterEach(() => {
    live.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const wait = (ms = CATCH_UP_GAP_MS) => vi.advanceTimersByTimeAsync(ms);

  it('does nothing on the first join', async () => {
    await wait(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [
      'joining again',
      () => {
        live.onStatus('CHANNEL_ERROR');
        live.onStatus('SUBSCRIBED');
      },
    ],
    ['coming back online', () => win.dispatchEvent(new Event('online'))],
    [
      'a long hide',
      () => {
        show('hidden');
        vi.setSystemTime(Date.now() + LONG_HIDE_MS + 1);
        show('visible');
      },
    ],
  ])('reads again and marks read after %s', async (_what, gap) => {
    await wait();
    gap();
    await wait();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenLastCalledWith(true);
  });

  it('retries a failed read and marks nothing until it succeeds', async () => {
    refresh.mockRejectedValueOnce(new Error('503'));
    live.catchUp();
    await wait();
    expect(settle).not.toHaveBeenCalled();
    await wait(RETRY_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith(true);
  });

  it('marks nothing when there is nothing to mark', async () => {
    refresh.mockResolvedValue(false);
    live.catchUp();
    await wait();
    expect(settle).not.toHaveBeenCalled();
  });

  it('offers to pay an owed mark each time the tab is shown', () => {
    show('hidden');
    show('visible');
    expect(settle.mock.calls).toEqual([[false], [false]]);
  });

  it('is over once stopped', async () => {
    live.stop();
    win.dispatchEvent(new Event('online'));
    show('hidden');
    await wait();
    expect(refresh).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
