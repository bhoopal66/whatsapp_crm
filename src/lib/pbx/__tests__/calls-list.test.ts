import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALLS_REFRESH_GAP_MS,
  CALLS_REFRESH_MS,
  callLeft,
  listReducer,
  loadCallsList,
  refreshedList,
  startCallsRefresh,
  type CallsList,
  type ListAction,
  type ListView,
  type ListedCall,
} from '../calls-list';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const SINCE = encodeURIComponent('2026-11-16T10:00:00.000Z');

/** `minute` after 08:00; the id breaks a tie. */
const c = (id: string, minute: number): ListedCall => ({
  id,
  startedAt: `2026-11-23T08:${String(minute).padStart(2, '0')}:00.5+00:00`,
});
const page = (
  calls: ListedCall[],
  truncated = false
): CallsList<ListedCall> => ({ calls, truncated, numbers: [] });
const ids = (l: CallsList<ListedCall> | null | undefined) =>
  l?.calls.map((x) => x.id);

describe('loadCallsList', () => {
  it('asks for the missed calls of the last seven days, and no tasks of its own', async () => {
    const getJson = vi.fn(async (url: string) => ({
      asked: url,
      calls: [{ id: 'c1' }],
      truncated: true,
    }));
    const list = await loadCallsList('missed', true, NOW, getJson);
    expect(getJson.mock.calls.map(([u]) => u)).toEqual([
      `/api/pbx/calls?scope=missed&limit=200&from=${SINCE}`,
    ]);
    expect(list).toEqual({
      calls: [{ id: 'c1' }],
      truncated: true,
      numbers: [],
    });
  });

  it('continues past a call with its instant as the API wrote it', async () => {
    const getJson = vi.fn(async (url: string) => ({ asked: url }));
    await loadCallsList('mine', false, NOW, getJson, {
      id: 'c9',
      startedAt: '2026-11-23T08:00:00.123456+00:00',
    });
    const q = new URL(getJson.mock.calls[0][0], 'https://x').searchParams;
    expect(q.get('before')).toBe('2026-11-23T08:00:00.123456+00:00');
    expect(q.get('beforeId')).toBe('c9');
  });

  it('reads nothing for a tab that loads its own', async () => {
    const getJson = vi.fn(async () => ({}));
    expect(await loadCallsList('keypad', false, NOW, getJson)).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });
});

describe('refreshedList', () => {
  const shown = page([c('e', 5), c('d', 4), c('c', 3), c('b', 2)], true);

  it('keeps the older calls the reader loaded, and whether more exist', () => {
    const fresh = page([c('f', 6), c('e', 5), c('d', 4)], true);
    const next = refreshedList(shown, fresh);
    expect(ids(next)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(refreshedList({ ...shown, truncated: false }, fresh).truncated).toBe(
      false
    );
  });

  it('drops a call the new first page no longer lists, not one past its end', () => {
    // d was answered late and left the missed list.
    expect(
      ids(refreshedList(shown, page([c('f', 6), c('e', 5), c('c', 3)], true)))
    ).toEqual(['f', 'e', 'c', 'b']);
  });

  it('tells calls of one instant, or of one millisecond, apart', () => {
    const tied = page([c('y', 5), c('x', 5), c('w', 5)], true);
    expect(
      ids(refreshedList(tied, page([c('z', 5), c('y', 5), c('x', 5)], true)))
    ).toEqual(['z', 'y', 'x', 'w']);
    const us = (id: string, micros: string) => ({
      id,
      startedAt: `2026-11-23T08:00:00.${micros}+00:00`,
    });
    expect(
      ids(
        refreshedList(
          page([us('a', '123456'), us('z', '123455')], true),
          page([us('a', '123456')], true)
        )
      )
    ).toEqual(['a', 'z']);
  });

  it('starts over when the first page is every call, or no longer meets the list', () => {
    expect(ids(refreshedList(shown, page([c('e', 5)])))).toEqual(['e']);
    const apart = page([c('k', 20), c('j', 19)], true);
    expect(refreshedList(shown, apart)).toBe(apart);
  });
});

describe('listReducer', () => {
  type V = ListView<ListedCall> | null;
  const run = (...actions: ListAction<ListedCall>[]) =>
    actions.reduce<V>((v, a) => listReducer(v, a), null);
  const loaded = (
    key: string,
    seq: number,
    calls: ListedCall[],
    more = false
  ) => ({ type: 'loaded', key, seq, list: page(calls, more) }) as const;

  it('never lets a late answer of an earlier tab, or an earlier read, win', () => {
    const v = run(
      loaded('missed', 2, [c('m', 1)]),
      loaded('mine', 1, [c('a', 1)]),
      { type: 'failed', key: 'mine', seq: 1 }
    );
    expect(v?.key).toBe('missed');
    expect(ids(v?.list)).toEqual(['m']);
    expect(
      ids(
        run(
          loaded('mine', 2, [c('b', 2), c('a', 1)]),
          loaded('mine', 1, [c('a', 1)])
        )?.list
      )
    ).toEqual(['b', 'a']);
  });

  it('keeps the list when a refresh fails, says so, and takes it back', () => {
    const stale = run(loaded('mine', 1, [c('a', 1)]), {
      type: 'failed',
      key: 'mine',
      seq: 2,
    });
    expect(stale).toMatchObject({ stale: true });
    expect(ids(stale?.list)).toEqual(['a']);
    expect(listReducer(stale, loaded('mine', 3, [c('a', 1)]))?.stale).toBe(
      false
    );
    // A first load that fails has no list to keep, whatever was shown before.
    expect(
      run(loaded('mine', 1, [c('a', 1)]), {
        type: 'failed',
        key: 'missed',
        seq: 2,
      })
    ).toMatchObject({ key: 'missed', list: null });
  });

  it('joins an older page to the list it continues, and only that', () => {
    const base = [loaded('mine', 1, [c('c', 3), c('b', 2)], true)] as const;
    const older = {
      type: 'older',
      key: 'mine',
      after: 'b',
      list: page([c('b', 2), c('a', 1)]),
    } as const;
    const v = run(...base, { type: 'olderStarted', key: 'mine' }, older);
    expect(ids(v?.list)).toEqual(['c', 'b', 'a']);
    expect(v).toMatchObject({ older: 'idle', list: { truncated: false } });
    // Another tab since, or a list started over: it does not meet it.
    expect(ids(run(loaded('missed', 2, [c('m', 9)]), older)?.list)).toEqual([
      'm',
    ]);
    expect(ids(run(loaded('mine', 2, [c('k', 9)], true), older)?.list)).toEqual(
      ['k']
    );
    expect(
      run(...base, { type: 'olderFailed', key: 'mine', after: 'b' })
    ).toMatchObject({ older: 'failed', list: { truncated: true } });
  });
});

describe('callLeft', () => {
  it('is a call that ended, not one that began or was answered', () => {
    expect(callLeft([], ['a'])).toBe(false);
    expect(callLeft(['a'], ['a'])).toBe(false);
    expect(callLeft(['a'], [])).toBe(true);
    expect(callLeft(['a'], ['b'])).toBe(true);
  });
});

describe('startCallsRefresh', () => {
  const target = () => {
    const on = new Map<string, () => void>();
    return {
      hidden: false,
      addEventListener: (t: string, fn: () => void) => void on.set(t, fn),
      removeEventListener: (t: string) => void on.delete(t),
      fire: (t: string) => on.get(t)?.(),
      count: () => on.size,
    };
  };
  let doc: ReturnType<typeof target>;
  let win: ReturnType<typeof target>;
  let run: ReturnType<typeof vi.fn<() => void>>;
  let r: ReturnType<typeof startCallsRefresh>;
  beforeEach(() => {
    vi.useFakeTimers();
    doc = target();
    win = target();
    run = vi.fn<() => void>();
    r = startCallsRefresh(run, doc, win);
  });
  afterEach(() => {
    r.stop();
    vi.useRealTimers();
  });

  it('reads every minute while on screen, and never in a hidden tab', () => {
    vi.advanceTimersByTime(CALLS_REFRESH_MS);
    expect(run).toHaveBeenCalledTimes(1);
    doc.hidden = true;
    vi.advanceTimersByTime(5 * CALLS_REFRESH_MS);
    r.soon();
    vi.advanceTimersByTime(CALLS_REFRESH_GAP_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reads once when shown again and focused together', () => {
    vi.advanceTimersByTime(10_000);
    doc.hidden = true;
    doc.fire('visibilitychange');
    expect(run).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.fire('visibilitychange');
    win.fire('focus');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reads a moment after a call ended, once for several', () => {
    r.soon();
    r.soon();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CALLS_REFRESH_GAP_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops', () => {
    r.soon();
    r.stop();
    vi.advanceTimersByTime(5 * CALLS_REFRESH_MS);
    expect(run).not.toHaveBeenCalled();
    expect(doc.count() + win.count()).toBe(0);
  });
});
