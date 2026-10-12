import { describe, expect, it } from 'vitest';

import {
  applyMessageEvent,
  applyReactionEvent,
  createTimeline,
  groupByDay,
  isGroupedWithPrevious,
  mergePage,
  summarizeReplies,
  timestampKey,
  withDetails,
  type TimelineState,
} from '../message-list';
import type { ChatMessage } from '../types';

const CH = 'c0000000-0000-4000-8000-000000000001';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const D = 'd0000000-0000-4000-8000-00000000000d';

const at = (min: number, sec = 0) =>
  new Date(Date.UTC(2026, 9, 12, 8, min, sec)).toISOString();

function msg(id: string, p: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channelId: CH,
    accountId: 'acc',
    threadRootId: null,
    authorKind: 'user',
    authorId: A,
    body: id,
    meta: {},
    createdAt: at(0),
    editedAt: null,
    deletedAt: null,
    erasedAt: null,
    attachments: [],
    reactions: [],
    thread: null,
    ...p,
  };
}

const ids = (s: TimelineState) => s.messages.map((m) => m.id);
const loaded = (...ms: ChatMessage[]) =>
  mergePage(createTimeline(CH), { messages: ms, hasMore: true });

describe('applyMessageEvent', () => {
  it('inserts in created_at order and dedupes by id', () => {
    let s = loaded(
      msg('m1', { createdAt: at(1) }),
      msg('m3', { createdAt: at(3) })
    );
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('m2', { createdAt: at(2) }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('m4', { createdAt: at(4) }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('m4', { createdAt: at(4) }),
    });
    expect(ids(s)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('orders by microseconds, then id', () => {
    let s: TimelineState = { ...createTimeline(CH), hasMoreOlder: false };
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('x2', { createdAt: '2026-10-12T08:00:00.000200+00:00' }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('x1', { createdAt: '2026-10-12 08:00:00.0001+00' }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('x0', { createdAt: '2026-10-12T08:00:00.0002+00:00' }),
    });
    expect(ids(s)).toEqual(['x1', 'x0', 'x2']);
  });

  it('ignores other channels and messages older than the loaded window', () => {
    const s = loaded(msg('m5', { createdAt: at(5) }));
    expect(
      applyMessageEvent(s, {
        type: 'insert',
        message: msg('o', { channelId: 'other', createdAt: at(6) }),
      })
    ).toBe(s);
    expect(
      applyMessageEvent(s, {
        type: 'insert',
        message: msg('old', { createdAt: at(1) }),
      })
    ).toBe(s);
    const all = { ...s, hasMoreOlder: false };
    expect(
      ids(
        applyMessageEvent(all, {
          type: 'insert',
          message: msg('old', { createdAt: at(1) }),
        })
      )
    ).toEqual(['old', 'm5']);
  });

  it('accepts every event into an empty, not yet loaded timeline', () => {
    const s = applyMessageEvent(createTimeline(CH), {
      type: 'insert',
      message: msg('m1'),
    });
    expect(ids(s)).toEqual(['m1']);
  });

  it('update keeps the details a realtime row lacks; a soft delete clears attachments and reactions', () => {
    const att = {
      id: 'f',
      messageId: 'm1',
      storagePath: 'p',
      name: 'n',
      mime: 'x',
      bytes: 1,
    };
    const reactions = [{ emoji: '👍', count: 1, userIds: [B] }];
    const thread = summarizeReplies([
      { id: 'r1', authorId: B, createdAt: at(2) },
    ]);
    let s = loaded(msg('m1', { attachments: [att], reactions, thread }));
    s = applyMessageEvent(s, {
      type: 'update',
      message: msg('m1', { body: 'edited', editedAt: at(3) }),
    });
    expect(s.messages[0]).toMatchObject({
      body: 'edited',
      attachments: [att],
      reactions,
      thread,
    });
    s = applyMessageEvent(s, {
      type: 'update',
      message: msg('m1', { body: '', deletedAt: at(4) }),
    });
    expect(s.messages[0]).toMatchObject({
      body: '',
      deletedAt: at(4),
      attachments: [],
      reactions: [],
      thread,
    });
    expect(ids(applyMessageEvent(s, { type: 'delete', id: 'm1' }))).toEqual([]);
  });

  it('thread replies update their root summary and never join the main list', () => {
    let s = loaded(msg('root', { createdAt: at(1) }));
    const reply = (id: string, author: string, min: number) =>
      msg(id, { threadRootId: 'root', authorId: author, createdAt: at(min) });
    for (const [id, who, min] of [
      ['r1', A, 2],
      ['r2', B, 3],
      ['r3', C, 4],
      ['r4', D, 5],
      ['r5', B, 6],
    ] as const) {
      s = applyMessageEvent(s, {
        type: 'insert',
        message: reply(id, who, min),
      });
    }
    s = applyMessageEvent(s, { type: 'insert', message: reply('r5', B, 6) }); // duplicate event
    expect(ids(s)).toEqual(['root']);
    expect(s.messages[0].thread).toMatchObject({
      replyCount: 5,
      lastReplyAt: at(6),
      authorIds: [B, D, C],
    });
    s = applyMessageEvent(s, {
      type: 'update',
      message: { ...reply('r5', B, 6), deletedAt: at(7) },
    });
    expect(s.messages[0].thread).toMatchObject({
      replyCount: 4,
      lastReplyAt: at(5),
      authorIds: [D, C, B],
    });
    const again = applyMessageEvent(s, {
      type: 'update',
      message: { ...reply('r5', B, 6), deletedAt: at(7) },
    });
    expect(again).toBe(s);
  });

  it('a reply to a root outside the list changes nothing', () => {
    const s = loaded(msg('m1'));
    const e = {
      type: 'insert' as const,
      message: msg('r', { threadRootId: 'gone', createdAt: at(9) }),
    };
    expect(applyMessageEvent(s, e)).toBe(s);
  });

  it('a thread timeline holds that root’s replies only', () => {
    let s = createTimeline(CH, 'root');
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('r1', { threadRootId: 'root', createdAt: at(2) }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('top', { createdAt: at(3) }),
    });
    s = applyMessageEvent(s, {
      type: 'insert',
      message: msg('x', { threadRootId: 'other', createdAt: at(4) }),
    });
    expect(ids(s)).toEqual(['r1']);
  });
});

describe('mergePage', () => {
  it('prepends an older page, keeps held copies, and records hasMore', () => {
    let s = loaded(msg('m3', { createdAt: at(3), body: 'held' }));
    s = mergePage(s, {
      messages: [
        msg('m1', { createdAt: at(1) }),
        msg('m3', { createdAt: at(3), body: 'page' }),
      ],
      hasMore: false,
    });
    expect(ids(s)).toEqual(['m1', 'm3']);
    expect(s.messages[1].body).toBe('held');
    expect(s.hasMoreOlder).toBe(false);
  });
});

describe('withDetails / applyReactionEvent', () => {
  it('fills details and toggles reactions idempotently', () => {
    const [m] = withDetails([msg('m1')], {
      reactions: { m1: [{ emoji: '👍', count: 1, userIds: [A] }] },
    });
    let s = loaded(m);
    s = applyReactionEvent(s, {
      type: 'add',
      messageId: 'm1',
      userId: B,
      emoji: '👍',
    });
    s = applyReactionEvent(s, {
      type: 'add',
      messageId: 'm1',
      userId: B,
      emoji: '👍',
    });
    s = applyReactionEvent(s, {
      type: 'add',
      messageId: 'm1',
      userId: A,
      emoji: '🎉',
    });
    expect(s.messages[0].reactions).toEqual([
      { emoji: '👍', count: 2, userIds: [A, B] },
      { emoji: '🎉', count: 1, userIds: [A] },
    ]);
    s = applyReactionEvent(s, {
      type: 'remove',
      messageId: 'm1',
      userId: A,
      emoji: '🎉',
    });
    expect(s.messages[0].reactions.map((r) => r.emoji)).toEqual(['👍']);
    expect(
      applyReactionEvent(s, {
        type: 'remove',
        messageId: 'nope',
        userId: A,
        emoji: '👍',
      })
    ).toBe(s);
  });
});

describe('groupByDay', () => {
  it('labels today / yesterday / dates in the given time zone', () => {
    const now = new Date('2026-10-12T10:00:00Z'); // 14:00 in Dubai
    const ms = [
      msg('a', { createdAt: '2026-10-10T12:00:00Z' }),
      msg('b', { createdAt: '2026-10-11T19:30:00Z' }), // 23:30 Dubai, Oct 11
      msg('c', { createdAt: '2026-10-11T20:30:00Z' }), // 00:30 Dubai, Oct 12
      msg('d', { createdAt: '2026-10-12T09:00:00Z' }),
    ];
    const g = groupByDay(ms, 'Asia/Dubai', now);
    expect(
      g.map((x) => [x.dayKey, x.kind, x.messages.map((m) => m.id).join('')])
    ).toEqual([
      ['2026-10-10', 'date', 'a'],
      ['2026-10-11', 'yesterday', 'b'],
      ['2026-10-12', 'today', 'cd'],
    ]);
    expect(groupByDay(ms, 'UTC', now).map((x) => x.kind)).toEqual([
      'date',
      'yesterday',
      'today',
    ]);
  });

  it('crosses a month boundary for yesterday', () => {
    const g = groupByDay(
      [msg('a', { createdAt: '2026-09-30T12:00:00Z' })],
      'UTC',
      new Date('2026-10-01T08:00:00Z')
    );
    expect(g[0].kind).toBe('yesterday');
  });
});

describe('isGroupedWithPrevious', () => {
  const prev = msg('p', { createdAt: at(0) });
  it('same author under 5 minutes is compact', () => {
    expect(
      isGroupedWithPrevious(prev, msg('n', { createdAt: at(4, 59) }))
    ).toBe(true);
    expect(isGroupedWithPrevious(prev, msg('n', { createdAt: at(5) }))).toBe(
      false
    );
    expect(
      isGroupedWithPrevious(prev, msg('n', { createdAt: at(1), authorId: B }))
    ).toBe(false);
    expect(isGroupedWithPrevious(undefined, prev)).toBe(false);
  });
  it('system posts never group', () => {
    const sys = (id: string) =>
      msg(id, { authorKind: 'system', authorId: null, createdAt: at(1) });
    expect(isGroupedWithPrevious(sys('s1'), sys('s2'))).toBe(false);
  });
  it('timestampKey keeps microsecond order', () => {
    expect(timestampKey('2026-10-12 08:00:00.000001+00')).toBeLessThan(
      timestampKey('2026-10-12T08:00:00.000002Z')
    );
  });
});
