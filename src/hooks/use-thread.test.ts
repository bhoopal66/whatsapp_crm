import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for, as in
// chat-resync-wiring.test.ts, but with their deps kept across renders.
type Cell = { deps: unknown[]; value?: unknown; cleanup?: () => void };
const cells: Cell[] = [];
let at = 0;
const keep = (deps: unknown[], make: (old?: Cell) => Partial<Cell>) => {
  const old = cells[at];
  if (!old || deps.some((d, i) => d !== old.deps[i]))
    cells[at] = { deps, ...make(old) };
  return cells[at++].value;
};
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useMemo: (fn: () => unknown, deps: unknown[]) =>
    keep(deps, () => ({ value: fn() })),
  useEffect: (fn: () => () => void, deps: unknown[]) =>
    keep(deps, (old) => {
      old?.cleanup?.();
      return { cleanup: fn() };
    }),
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));

const reads: {
  rootId: string;
  answer: (bodies: string[]) => void;
  fail: () => void;
}[] = [];
vi.mock('@/lib/chat/thread', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/thread')>()),
  threadReads: (_sb: unknown, channelId: string, rootId: string) => ({
    root: async () => ({ ...message(rootId, channelId), threadRootId: null }),
    page: () =>
      new Promise((ok, no) =>
        reads.push({
          rootId,
          answer: (bodies) =>
            ok({
              messages: bodies.map((b) => ({
                ...message(b, channelId),
                threadRootId: rootId,
              })),
              hasMore: false,
            }),
          fail: () => no(new Error('503')),
        })
      ),
    details: async () => ({
      attachments: {},
      reactions: {},
      threads: {},
      cards: [],
      callCards: [],
    }),
  }),
}));
const message = (id: string, channelId: string) => ({
  id,
  channelId,
  body: id,
  createdAt: '2026-11-23T08:00:00+00:00',
  deletedAt: null,
  attachments: [],
  reactions: [],
  thread: null,
});

import type { ChatEvent } from './use-chat-workspace';
import { useThread } from './use-thread';

const listeners = new Set<(e: ChatEvent) => unknown>();
const emit = (e: ChatEvent) => [...listeners].map((fn) => fn(e));
const fail = vi.fn();
const ws = {
  sb: {} as never,
  fail: fail as never,
  listen: (fn: (e: ChatEvent) => unknown) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
/** Draws the panel for a thread and answers what it shows. */
const Panel = (rootId: string) => {
  at = 0;
  return useThread(ws, 'c1', rootId).view;
};
const bodies = (rootId: string) =>
  Panel(rootId).replies.timeline.messages.map((m) => m.body);
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  reads.length = 0;
  fail.mockClear();
});
afterEach(() => {
  cells.splice(0).forEach((c) => c.cleanup?.());
});

describe('useThread', () => {
  it('reads the thread again after a gap', async () => {
    Panel('A');
    reads[0].answer(['one']);
    await settle();
    expect(bodies('A')).toEqual(['one']);
    emit({ kind: 'resync' });
    expect(reads).toHaveLength(2);
    reads[1].answer(['one', 'two']);
    await settle();
    expect(bodies('A')).toEqual(['one', 'two']);
  });

  it('tells the catch-up whether the thread was read again', async () => {
    Panel('A');
    reads[0].answer(['one']);
    await settle();
    const [failed] = emit({ kind: 'resync' });
    reads[1].fail();
    await expect(failed).rejects.toThrow();
    expect(bodies('A')).toEqual(['one']);
    expect(fail).not.toHaveBeenCalled();

    const [read] = emit({ kind: 'resync' });
    reads[2].answer(['one', 'two']);
    await expect(read).resolves.toBeUndefined();
    expect(bodies('A')).toEqual(['one', 'two']);
  });

  it('a read overtaken by a newer one is not tried again', async () => {
    Panel('A');
    reads[0].answer(['one']);
    await settle();
    const [older] = emit({ kind: 'resync' });
    const [newer] = emit({ kind: 'resync' });
    reads[2].answer(['one', 'two']);
    await expect(newer).resolves.toBeUndefined();
    reads[1].fail();
    await expect(older).resolves.toBeUndefined();
  });

  it('applies messages and reactions as they come', async () => {
    Panel('A');
    reads[0].answer([]);
    await settle();
    emit({
      kind: 'message',
      event: {
        type: 'insert',
        message: { ...message('live', 'c1'), threadRootId: 'A' } as never,
      },
    });
    emit({
      kind: 'reaction',
      event: { type: 'add', messageId: 'live', userId: 'u', emoji: '👍' },
    });
    const [m] = Panel('A').replies.timeline.messages;
    expect([m.body, m.reactions[0].emoji]).toEqual(['live', '👍']);
  });

  it('a slow answer never lands in the thread opened next', async () => {
    Panel('A');
    expect(bodies('B')).toEqual([]);
    expect(reads.map((r) => r.rootId)).toEqual(['A', 'B']);
    reads[0].answer(['from A']);
    await settle();
    expect(Panel('B').phase).toBe('loading');
    expect(bodies('B')).toEqual([]);
    reads[1].answer(['from B']);
    await settle();
    expect(bodies('B')).toEqual(['from B']);
  });

  it('a late failure of the thread left is not shown over the next', async () => {
    Panel('A');
    Panel('B');
    reads[0].fail();
    await settle();
    expect(fail).not.toHaveBeenCalled();
    expect(Panel('B').phase).toBe('loading');
  });

  it('stops listening with the panel', () => {
    Panel('A');
    cells.splice(0).forEach((c) => c.cleanup?.());
    expect(listeners.size).toBe(0);
  });
});
