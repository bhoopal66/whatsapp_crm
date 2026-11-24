import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CATCH_UP_RETRY_MS,
  createThreadStore,
  readReplies,
  REPLY_LIMIT,
  threadReads,
  type ThreadDetails,
  type ThreadReads,
} from '../thread';
import type { ChatMessage, MessagePage } from '../types';

const CH = 'c0000000-0000-4000-8000-000000000001';
const ROOT = 'b0000000-0000-4000-8000-000000000001';

const at = (min: number) =>
  new Date(Date.UTC(2026, 10, 23, 8, min)).toISOString();

function msg(id: string, min: number, p: Partial<ChatMessage> = {}) {
  const m: ChatMessage = {
    id,
    channelId: CH,
    accountId: 'acc',
    threadRootId: ROOT,
    authorKind: 'user',
    authorId: 'u',
    body: id,
    meta: {},
    createdAt: at(min),
    editedAt: null,
    deletedAt: null,
    erasedAt: null,
    deletedBy: null,
    replyToId: null,
    forwarded: null,
    attachments: [],
    reactions: [],
    thread: null,
    ...p,
  };
  return m;
}
const root = msg(ROOT, 0, { threadRootId: null });
const page = (messages: ChatMessage[], hasMore = false): MessagePage => ({
  messages,
  hasMore,
});
const NO_DETAILS: ThreadDetails = {
  attachments: {},
  reactions: {},
  threads: {},
  cards: [],
  callCards: [],
};
const file = { id: 'f1' } as unknown as ChatMessage['attachments'][number];

/** Every read held until the test answers it. */
function deferredReads() {
  const pages: {
    before?: { id: string };
    answer: (p: MessagePage) => void;
    fail: (e: unknown) => void;
  }[] = [];
  const reads = {
    root: vi.fn(async (): Promise<ChatMessage | null> => root),
    page: vi.fn(
      (before?: { id: string }) =>
        new Promise<MessagePage>((answer, fail) =>
          pages.push({ before, answer, fail })
        )
    ),
    details: vi.fn(async (): Promise<ThreadDetails> => NO_DETAILS),
  };
  return { reads: reads as typeof reads & ThreadReads, pages };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const insert = (message: ChatMessage) =>
  ({ kind: 'message', event: { type: 'insert', message } }) as const;

async function opened(messages: ChatMessage[], hasMore = false) {
  const { reads, pages } = deferredReads();
  const store = createThreadStore(reads, CH, ROOT);
  const fail = vi.fn();
  const leave = store.show(fail);
  pages[0].answer(page(messages, hasMore));
  await settle();
  pages.length = 0;
  reads.details.mockClear();
  return { store, reads, pages, fail, leave };
}
type Store = Awaited<ReturnType<typeof opened>>['store'];
const bodies = (s: Store) =>
  s.get().replies.timeline.messages.map((m) => m.body);
const reply = (s: Store, id: string) =>
  s.get().replies.timeline.messages.find((m) => m.id === id);

describe('opening a thread', () => {
  it('shows the root and the replies, with a reply that landed meanwhile', async () => {
    const { reads, pages } = deferredReads();
    const store = createThreadStore(reads, CH, ROOT);
    store.show(() => {});
    store.record(insert(msg('r2', 2)));
    expect(store.get().phase).toBe('loading');
    // The snapshot was taken before r2.
    reads.details.mockResolvedValue({
      ...NO_DETAILS,
      attachments: { r2: [file] },
    });
    pages[0].answer(page([msg('r1', 1)]));
    await settle();
    expect(store.get().phase).toBe('ready');
    expect(store.get().root.timeline.messages.map((m) => m.id)).toEqual([ROOT]);
    expect(bodies(store)).toEqual(['r1', 'r2']);
    expect(reply(store, 'r2')?.attachments).toEqual([file]);
  });

  it('keeps an edit and a removal made during the read', async () => {
    const { reads, pages } = deferredReads();
    const store = createThreadStore(reads, CH, ROOT);
    store.show(() => {});
    store.record({
      kind: 'message',
      event: { type: 'update', message: msg('r1', 1, { body: 'new' }) },
    });
    store.record({ kind: 'message', event: { type: 'delete', id: 'r2' } });
    pages[0].answer(page([msg('r1', 1), msg('r2', 2)]));
    await settle();
    expect(bodies(store)).toEqual(['new']);
  });

  it('a failed first read says so, and Try again reads it', async () => {
    const { reads, pages } = deferredReads();
    const store = createThreadStore(reads, CH, ROOT);
    const fail = vi.fn();
    store.show(fail);
    pages[0].fail(new Error('503'));
    await settle();
    expect(store.get().phase).toBe('failed');
    expect(fail).toHaveBeenCalledTimes(1);
    store.retry();
    expect(store.get().phase).toBe('loading');
    pages[1].answer(page([msg('r1', 1)]));
    await settle();
    expect(store.get().phase).toBe('ready');
    expect(bodies(store)).toEqual(['r1']);
  });

  it('a resync during a failing first read still shows the thread', async () => {
    const { reads, pages } = deferredReads();
    const store = createThreadStore(reads, CH, ROOT);
    const fail = vi.fn();
    store.show(fail);
    store.resync();
    pages[0].fail(new Error('asleep'));
    await settle();
    expect(store.get().phase).toBe('loading');
    pages[1].answer(page([msg('r1', 1)]));
    await settle();
    expect(store.get().phase).toBe('ready');
    expect(fail).not.toHaveBeenCalled();
  });

  it('events of another thread are not its own', async () => {
    const { store, reads } = await opened([msg('r1', 1)]);
    const before = store.get();
    store.record(insert(msg('x', 2, { threadRootId: 'other' })));
    store.record(insert(msg('y', 2, { threadRootId: null })));
    expect(store.get()).toBe(before);
    expect(reads.details).not.toHaveBeenCalled();
  });
});

describe('a resync of an open thread', () => {
  it('shows what was missed: a reply, an edit, a removal', async () => {
    const { store, pages } = await opened([
      msg('r1', 1),
      msg('r2', 2, { attachments: [file] }),
      msg('r3', 3),
    ]);
    store.resync();
    // What is shown stays while it reads.
    expect(bodies(store)).toEqual(['r1', 'r2', 'r3']);
    expect(store.get().phase).toBe('ready');
    pages[0].answer(
      page([
        msg('r1', 1, { body: 'edited', editedAt: at(5) }),
        msg('r2', 2, { body: '', deletedAt: at(5), deletedBy: 'admin' }),
        msg('r3', 3),
        msg('r4', 4),
      ])
    );
    await settle();
    expect(reply(store, 'r1')?.body).toBe('edited');
    expect(reply(store, 'r2')).toMatchObject({
      deletedAt: at(5),
      deletedBy: 'admin',
      attachments: [],
    });
    expect(reply(store, 'r4')).toBeDefined();
  });

  it('refreshes the root, its count and its cards', async () => {
    const { store, reads, pages } = await opened([]);
    const card = { messageId: ROOT } as never;
    reads.root.mockResolvedValue({ ...root, body: 'root edited' });
    const summary = {
      replyCount: 7,
      lastReplyAt: at(1),
      authorIds: [],
      replies: [],
    };
    reads.details.mockResolvedValue({
      ...NO_DETAILS,
      threads: { [ROOT]: summary },
      cards: [card],
    });
    store.resync();
    pages[0].answer(page([]));
    await settle();
    expect(store.get().root.timeline.messages[0]).toMatchObject({
      body: 'root edited',
      thread: summary,
    });
    expect(store.get().root.cards[ROOT]).toBe(card);
    reads.details.mockResolvedValue(NO_DETAILS);
    store.resync();
    pages[1].answer(page([]));
    await settle();
    expect(store.get().root.cards).toEqual({});
  });

  it('keeps a reply that arrives during the read, and its late details', async () => {
    const { store, reads, pages } = await opened([msg('r1', 1)]);
    reads.details.mockResolvedValue({
      ...NO_DETAILS,
      attachments: { r2: [file] },
    });
    store.resync();
    store.record(insert(msg('r2', 2)));
    pages[0].answer(page([msg('r1', 1)]));
    await settle();
    expect(bodies(store)).toEqual(['r1', 'r2']);
    expect(reply(store, 'r2')?.attachments).toEqual([file]);
  });

  it('an edit while a new reply’s files are read is not undone', async () => {
    const { store, reads } = await opened([]);
    let answer: (d: ThreadDetails) => void = () => {};
    reads.details.mockReturnValue(new Promise((ok) => (answer = ok)));
    store.record(insert(msg('r1', 1)));
    store.record({
      kind: 'message',
      event: { type: 'update', message: msg('r1', 1, { body: 'edited' }) },
    });
    answer({ ...NO_DETAILS, attachments: { r1: [file] } });
    await settle();
    expect(reply(store, 'r1')).toMatchObject({
      body: 'edited',
      attachments: [file],
    });
  });

  it('a failed one keeps what is shown, quietly, and the next one reads', async () => {
    const { store, pages, fail } = await opened([msg('r1', 1)]);
    store.resync();
    pages[0].fail(new Error('503'));
    await settle();
    expect([bodies(store), store.get().phase]).toEqual([['r1'], 'ready']);
    expect(fail).not.toHaveBeenCalled();
    store.resync();
    pages[1].answer(page([msg('r1', 1), msg('r2', 2)]));
    await settle();
    expect(bodies(store)).toEqual(['r1', 'r2']);
  });

  it('an older read landing after a newer one changes nothing', async () => {
    const { store, pages } = await opened([msg('r1', 1)]);
    store.resync();
    store.resync();
    pages[1].answer(page([msg('r1', 1, { body: 'newest' })]));
    await settle();
    pages[0].answer(page([msg('r1', 1, { body: 'stale' })]));
    await settle();
    expect(bodies(store)).toEqual(['newest']);
  });

  it('leaves no read open: the journal is empty after each outcome', async () => {
    const { store, pages, leave } = await opened([msg('r1', 1)]);
    store.resync();
    store.resync();
    store.resync();
    pages[1].answer(page([msg('r1', 1)]));
    pages[2].fail(new Error('503'));
    await settle();
    leave();
    pages[0].answer(page([msg('r1', 1)]));
    await settle();
    const { root: r, replies } = store.get();
    expect([r.flights, replies.flights]).toEqual([[], []]);
    expect([r.journal, replies.journal]).toEqual([[], []]);
  });
});

describe('a failed catch-up read', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const later = async () => {
    await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
    await settle();
  };

  it('is tried again a little later, once, quietly', async () => {
    const { store, pages, fail } = await opened([msg('r1', 1)]);
    store.resync();
    pages[0].fail(new Error('503'));
    await settle();
    expect(pages).toHaveLength(1);
    await later();
    pages[1].answer(page([msg('r1', 1), msg('r2', 2)]));
    await settle();
    expect(bodies(store)).toEqual(['r1', 'r2']);
    await later();
    expect(pages).toHaveLength(2);

    store.resync();
    pages[2].fail(new Error('503'));
    await settle();
    await later();
    pages[3].fail(new Error('503'));
    await settle();
    await later();
    expect(pages).toHaveLength(4);
    expect(fail).not.toHaveBeenCalled();
  });

  it('is not, once a read begun after it has landed', async () => {
    const { store, pages } = await opened([msg('r1', 1)]);
    store.resync();
    store.resync();
    pages[1].answer(page([msg('r1', 1), msg('r2', 2)]));
    pages[0].fail(new Error('503'));
    await settle();
    await later();
    expect(pages).toHaveLength(2);
  });

  it('is, when only a read begun before it has landed', async () => {
    const { store, pages } = await opened([msg('r1', 1)]);
    store.resync();
    store.resync();
    pages[1].fail(new Error('503'));
    pages[0].answer(page([msg('r1', 1)]));
    await settle();
    await later();
    expect(pages).toHaveLength(3);
  });

  it('is not, after the thread was left', async () => {
    const { store, pages, leave } = await opened([msg('r1', 1)]);
    store.resync();
    pages[0].fail(new Error('503'));
    await settle();
    leave();
    store.show(() => {});
    pages[1].answer(page([msg('r1', 1)]));
    await settle();
    await later();
    expect(pages).toHaveLength(2);
  });
});

describe('leaving a thread', () => {
  it('a slow answer or a late failure after it changes and says nothing', async () => {
    const { store, pages, fail, leave } = await opened([msg('r1', 1)], true);
    store.resync();
    void store.loadOlder();
    leave();
    pages[0].answer(page([msg('r1', 1, { body: 'late' })]));
    pages[1].fail(new Error('503'));
    await settle();
    expect(bodies(store)).toEqual(['r1']);
    expect(fail).not.toHaveBeenCalled();
    store.resync();
    expect(pages).toHaveLength(2);
  });

  it('a first read that fails after it says nothing', async () => {
    const { reads, pages } = deferredReads();
    const store = createThreadStore(reads, CH, ROOT);
    const fail = vi.fn();
    store.show(fail)();
    pages[0].fail(new Error('503'));
    await settle();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('older replies', () => {
  it('load before the oldest shown, with their details', async () => {
    const { store, reads, pages } = await opened([msg('r5', 5)], true);
    reads.details.mockResolvedValue({
      ...NO_DETAILS,
      attachments: { r4: [file] },
    });
    void store.loadOlder();
    expect(store.get().loadingOlder).toBe(true);
    expect(pages[0].before).toMatchObject({ id: 'r5', createdAt: at(5) });
    // A second press meanwhile does nothing.
    void store.loadOlder();
    expect(pages).toHaveLength(1);
    pages[0].answer(page([msg('r3', 3), msg('r4', 4)]));
    await settle();
    expect(bodies(store)).toEqual(['r3', 'r4', 'r5']);
    expect(reply(store, 'r4')?.attachments).toEqual([file]);
    expect(store.get().loadingOlder).toBe(false);
    expect(store.get().replies.timeline.hasMoreOlder).toBe(false);
    void store.loadOlder();
    expect(pages).toHaveLength(1);
  });

  it('a failure says so and can be pressed again', async () => {
    const { store, pages, fail } = await opened([msg('r5', 5)], true);
    void store.loadOlder();
    pages[0].fail(new Error('503'));
    await settle();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(store.get().loadingOlder).toBe(false);
    void store.loadOlder();
    expect(pages).toHaveLength(2);
  });

  it('stay through a resync, which re-reads them too', async () => {
    const { store, pages } = await opened([msg('r5', 5)], true);
    void store.loadOlder();
    pages[0].answer(page([msg('r3', 3), msg('r4', 4)], true));
    await settle();
    store.resync();
    pages[1].answer(page([msg('r5', 5), msg('r6', 6)], true));
    await settle();
    expect(pages[2].before).toMatchObject({ id: 'r5' });
    // Reaches past the window, which does not grow.
    pages[2].answer(
      page([
        msg('r2', 2),
        msg('r3', 3, { body: '', deletedAt: at(7) }),
        msg('r4', 4, { body: 'r4 edited' }),
      ])
    );
    await settle();
    expect(bodies(store)).toEqual(['', 'r4 edited', 'r5', 'r6']);
    expect(store.get().replies.timeline.hasMoreOlder).toBe(true);
  });

  it('that land during a resync stay below what it read', async () => {
    const { store, pages } = await opened([msg('r5', 5)], true);
    store.resync();
    void store.loadOlder();
    pages[1].answer(page([msg('r4', 4)]));
    await settle();
    pages[0].answer(page([msg('r5', 5, { body: 'edited' })], true));
    await settle();
    expect(bodies(store)).toEqual(['r4', 'edited']);
    expect(store.get().replies.timeline.hasMoreOlder).toBe(false);
  });

  it('are dropped when a resync started the window over', async () => {
    const { store, pages } = await opened([msg('r5', 5)], true);
    void store.loadOlder();
    store.resync();
    // Far more was missed than the two pages it reads.
    pages[1].answer(page([msg('r9', 9)], true));
    await settle();
    pages[2].answer(page([msg('r8', 8)], true));
    await settle();
    expect(bodies(store)).toEqual(['r8', 'r9']);
    pages[0].answer(page([msg('r4', 4)]));
    await settle();
    expect(bodies(store)).toEqual(['r8', 'r9']);
    expect(store.get().replies.timeline.hasMoreOlder).toBe(true);
  });
});

describe('readReplies', () => {
  it('reads one page when it reaches what is held', async () => {
    const read = vi.fn(async () => page([msg('r1', 1), msg('r2', 2)], true));
    await readReplies(read, []);
    await readReplies(read, [msg('r1', 1)]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads at most one page more than is held', async () => {
    let min = 5000;
    const read = vi.fn(async () => page([msg(`n${min}`, min--)], true));
    const held = Array.from({ length: REPLY_LIMIT + 1 }, (_, i) =>
      msg(`h${i}`, i)
    );
    const out = await readReplies(read, held);
    expect(read).toHaveBeenCalledTimes(3);
    expect(out.hasMore).toBe(true);
    expect(out.messages.map((m) => m.id)).toEqual(['n4998', 'n4999', 'n5000']);
  });
});

describe('threadReads', () => {
  it('reads the root; none is not a failure, an error is', async () => {
    const answer = (v: unknown) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => v };
      return threadReads({ from: () => q } as never, CH, ROOT).root();
    };
    expect((await answer({ data: { id: ROOT }, error: null }))?.id).toBe(ROOT);
    expect(await answer({ data: null, error: null })).toBeNull();
    await expect(
      answer({ data: null, error: { message: 'x' } })
    ).rejects.toThrow('x');
  });

  it('asks for the details of at most a page of messages at once', async () => {
    const asked: [string, number][] = [];
    const sb = {
      from: (table: string) => {
        const q = {
          select: () => q,
          order: () => q,
          in: (_c: string, ids: string[]) => {
            asked.push([table, ids.length]);
            return q;
          },
          then: (ok: (v: unknown) => void) => ok({ data: [], error: null }),
        };
        return q;
      },
    };
    const ids = Array.from({ length: REPLY_LIMIT + 1 }, (_, i) => `m${i}`);
    const details = await threadReads(sb as never, CH, ROOT).details(ids, []);
    expect(details).toEqual(NO_DETAILS);
    expect(asked.map(([, n]) => n)).toEqual([REPLY_LIMIT, 1, REPLY_LIMIT, 1]);
  });
});
