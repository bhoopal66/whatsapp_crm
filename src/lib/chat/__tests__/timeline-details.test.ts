import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createForwardIds, forwardToAll } from '../forward';
import { createThreadStore } from '../thread';
import {
  missingFiles,
  placeholderTimeline,
  recordTimelineEvent,
  TIMELINE_JOURNAL_MAX,
  type CachedTimeline,
  type DetailKind,
} from '../timeline-cache';
import {
  createDetailLoader,
  DETAIL_RETRY_DELAYS_MS,
} from '../timeline-details';
import type { ChatMessage } from '../types';

const CH = 'c0000000-0000-4000-8000-000000000001';
const msg = (id: string, p: Partial<ChatMessage> = {}) =>
  ({
    id,
    channelId: CH,
    threadRootId: null,
    authorKind: 'user',
    createdAt: '2026-11-24T08:00:00+00:00',
    deletedAt: null,
    erasedAt: null,
    attachments: [],
    reactions: [],
    thread: null,
    ...p,
  }) as unknown as ChatMessage;
const file = { id: 'f1' } as unknown as ChatMessage['attachments'][number];
const thumb = { emoji: '👍', count: 1, userIds: ['u'] };

/** A loader over one entry; the kinds in `down` fail. */
function loaderOf(messages: ChatMessage[]) {
  const start = placeholderTimeline(CH);
  let entry: CachedTimeline = {
    ...start,
    loaded: true,
    timeline: { ...start.timeline, messages },
  };
  const down = new Set<DetailKind>();
  const read = vi.fn(async (kind: DetailKind, ids: string[]) => {
    if (down.has(kind)) throw new Error('503');
    const of = (v: unknown) => Object.fromEntries(ids.map((id) => [id, v]));
    if (kind === 'attachments') return of([file]);
    if (kind === 'reactions') return of([thumb]);
    return kind === 'threads' ? {} : [];
  });
  const loader = createDetailLoader({
    read: read as never,
    get: () => entry,
    patch: (fn) => void (entry = fn(entry)),
  });
  const leave = loader.show();
  const asked = (kind: DetailKind) =>
    read.mock.calls.filter(([k]) => k === kind).map(([, ids]) => ids);
  const change = (fn: (e: CachedTimeline) => CachedTimeline) =>
    void (entry = fn(entry));
  return { loader, down, read, asked, leave, change, entry: () => entry };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('the details of messages', () => {
  it('settle each kind alone, and only the failed one is read again', async () => {
    const x = loaderOf([msg('m1'), msg('m2')]);
    x.down.add('attachments');
    await x.loader.load(['m1', 'm2']);
    expect(x.entry().timeline.messages[0].reactions).toEqual([thumb]);
    expect(x.entry().missing.attachments).toEqual(['m1', 'm2']);
    expect(x.entry().flights).toEqual([]);
    expect([...missingFiles(x.entry())]).toEqual(['m1', 'm2']);

    x.down.clear();
    await vi.advanceTimersByTimeAsync(DETAIL_RETRY_DELAYS_MS[0]);
    expect(x.entry().timeline.messages[0].attachments).toEqual([file]);
    expect(missingFiles(x.entry()).size).toBe(0);
    expect(x.asked('attachments')).toHaveLength(2);
    expect(x.asked('reactions')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.asked('attachments')).toHaveLength(2);
  });

  it('are given up after the last delay, until a catch-up or a Retry', async () => {
    const x = loaderOf([msg('m1'), msg('m2')]);
    x.down.add('attachments');
    await x.loader.load(['m1']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(x.asked('attachments')).toHaveLength(4);
    // The catch-up reads its own page, and what is missing below it.
    x.down.clear();
    await x.loader.catchUp(['m2']);
    expect(x.asked('attachments').slice(4)).toEqual([['m1'], ['m2']]);
    expect(missingFiles(x.entry()).size).toBe(0);

    x.down.add('attachments');
    await x.loader.load(['m1']);
    x.down.clear();
    x.loader.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(x.entry().missing.attachments).toEqual([]);
  });

  it('are not read again once the channel was left', async () => {
    const x = loaderOf([msg('m1')]);
    x.down.add('attachments');
    await x.loader.load(['m1']);
    x.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.asked('attachments')).toHaveLength(1);
  });

  it('ask for at most a URL of ids at once', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `m${i}`);
    const x = loaderOf(ids.map((id) => msg(id)));
    await x.loader.load(ids);
    expect(x.asked('attachments').map((c) => c.length)).toEqual([200, 1]);
  });

  it('say a file is missing only of a live message never read before', async () => {
    const x = loaderOf([
      msg('read'),
      msg('new'),
      msg('gone', { deletedAt: 'x' }),
      msg('system', { authorKind: 'system' }),
    ]);
    await x.loader.load(['read']);
    x.down.add('attachments');
    await x.loader.load(['read', 'new', 'gone', 'system']);
    expect([...missingFiles(x.entry())]).toEqual(['new']);
    // What was read stays through the failed re-read.
    expect(x.entry().timeline.messages[0].attachments).toEqual([file]);
  });

  it('of a new thread reply are read again too', async () => {
    let down = true;
    const details = vi.fn(
      async (ids: string[], _r: string[], only?: string) => {
        if (down && only === 'attachments') throw new Error('503');
        return {
          attachments: Object.fromEntries(ids.map((id) => [id, [file]])),
          reactions: Object.fromEntries(ids.map((id) => [id, [thumb]])),
          threads: {},
          cards: [],
          callCards: [],
        };
      }
    );
    const store = createThreadStore(
      {
        root: async () => msg('root'),
        page: async () => ({ messages: [], hasMore: false }),
        details,
      },
      CH,
      'root'
    );
    const leave = store.show(() => {});
    await vi.advanceTimersByTimeAsync(0);
    store.record({
      kind: 'message',
      event: { type: 'insert', message: msg('r1', { threadRootId: 'root' }) },
    });
    await vi.advanceTimersByTimeAsync(0);
    const reply = () => store.get().replies.timeline.messages[0];
    expect(reply().reactions).toEqual([thumb]);
    expect([...missingFiles(store.get().replies)]).toEqual(['r1']);
    down = false;
    await vi.advanceTimersByTimeAsync(DETAIL_RETRY_DELAYS_MS[0]);
    expect(reply().attachments).toEqual([file]);
    leave();
  });
});

describe('an answer dropped for a full journal', () => {
  it('is read again', async () => {
    const { loader, read, change, asked, entry, leave } = loaderOf([msg('m1')]);
    let answer: (v: unknown) => void = () => {};
    read.mockImplementationOnce(
      () => new Promise((r) => (answer = r)) as Promise<never>
    );
    const loading = loader.load(['m1']);
    change((e) => {
      for (let i = 0; i <= TIMELINE_JOURNAL_MAX; i++)
        e = recordTimelineEvent(e, {
          kind: 'message',
          event: { type: 'insert', message: msg(`live${i}`) },
        });
      return e;
    });
    answer({ m1: [file] });
    await loading;
    expect([...missingFiles(entry())]).toContain('m1');
    const before = asked('attachments').length;
    await vi.advanceTimersByTimeAsync(DETAIL_RETRY_DELAYS_MS[0]);
    expect(asked('attachments').length).toBeGreaterThan(before);
    expect([...missingFiles(entry())]).not.toContain('m1');
    leave();
  });
});

describe('a forward', () => {
  it('carries the files it read, to each target', async () => {
    const send = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('no');
    });
    const files = async () => [file];
    const ids = createForwardIds((() => 'one') as never);
    const sent = await forwardToAll(['a', 'b', 'c'], ids, { files, send });
    expect(sent).toMatchObject({
      read: true,
      done: 2,
      failed: [{ id: 'b', error: expect.any(Error) }],
    });
    expect(send.mock.calls).toEqual(
      ['a', 'b', 'c'].map((id) => [id, [file], 'one'])
    );
  });

  it('is refused whole when its files could not be read', async () => {
    const send = vi.fn();
    const sent = await forwardToAll(['a'], createForwardIds(), {
      files: () => Promise.reject(new Error('503')),
      send,
    });
    expect(sent).toEqual({ read: false });
    expect(send).not.toHaveBeenCalled();
  });
});
