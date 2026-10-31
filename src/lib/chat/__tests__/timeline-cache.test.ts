import { describe, expect, it } from 'vitest';

import { sessionKey } from '@/lib/session-cache';

import {
  isNavSettled,
  optimisticActiveId,
  type PendingChannelNav,
} from '../sidebar-nav';
import {
  applyOlderPage,
  applyTimelineDetails,
  beginTimelineFetch,
  droppedChannelIds,
  endTimelineFetch,
  placeholderTimeline,
  recordTimelineEvent,
  revalidateTimeline,
  shouldPrefetchTimeline,
  timelineCacheKey,
  timelineEventTargets,
  timelineMark,
  TIMELINE_JOURNAL_MAX,
  TIMELINE_PREFETCH_FRESH_MS,
  type CachedTimeline,
  type TimelineEvent,
} from '../timeline-cache';
import type { ChatMessage, SharedCard } from '../types';

const CH = 'c0000000-0000-4000-8000-000000000001';
const OTHER = 'c0000000-0000-4000-8000-000000000002';
const U = 'a0000000-0000-4000-8000-00000000000a';

const at = (min: number) =>
  new Date(Date.UTC(2026, 9, 12, 8, min)).toISOString();

function msg(id: string, min: number, p: Partial<ChatMessage> = {}) {
  const m: ChatMessage = {
    id,
    channelId: CH,
    accountId: 'acc',
    threadRootId: null,
    authorKind: 'user',
    authorId: U,
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

const heart = { emoji: '❤️', count: 1, userIds: [U] };
const file = { id: 'f1' } as unknown as ChatMessage['attachments'][number];
const thread = {
  replyCount: 1,
  lastReplyAt: at(9),
  authorIds: [U],
  replies: [],
};

function cached(
  messages: ChatMessage[],
  p: Partial<CachedTimeline> = {}
): CachedTimeline {
  return {
    ...placeholderTimeline(CH),
    timeline: {
      channelId: CH,
      threadRootId: null,
      messages,
      hasMoreOlder: false,
    },
    loaded: true,
    fetchedAt: 1,
    ...p,
  };
}

const ids = (e: CachedTimeline) => e.timeline.messages.map((m) => m.id);

/** A fetch opened on `entry`, with `events` recorded during its flight. */
function inFlight(entry: CachedTimeline, events: TimelineEvent[] = []) {
  const mark = timelineMark();
  let e = beginTimelineFetch(entry, mark);
  for (const ev of events) e = recordTimelineEvent(e, ev);
  return { entry: e, mark };
}

const inserted = (m: ChatMessage): TimelineEvent => ({
  kind: 'message',
  event: { type: 'insert', message: m },
});
const updated = (m: ChatMessage): TimelineEvent => ({
  kind: 'message',
  event: { type: 'update', message: m },
});
const deleted = (id: string): TimelineEvent => ({
  kind: 'message',
  event: { type: 'delete', id },
});
const reacted = (messageId: string): TimelineEvent => ({
  kind: 'reaction',
  event: { type: 'add', messageId, userId: U, emoji: heart.emoji },
});

describe('timelineCacheKey', () => {
  it('names the channel under the account and user', () => {
    expect(timelineCacheKey('acc', U, CH)).toBe(
      sessionKey('acc', U, `chat:timeline:${CH}`)
    );
    expect(timelineCacheKey('acc', U, CH)).not.toBe(
      timelineCacheKey('acc', U, OTHER)
    );
    expect(timelineCacheKey('acc', 'someone-else', CH)).not.toBe(
      timelineCacheKey('acc', U, CH)
    );
  });

  it('is null until account and user are known', () => {
    expect(timelineCacheKey(null, U, CH)).toBeNull();
    expect(timelineCacheKey('acc', undefined, CH)).toBeNull();
  });
});

describe('revalidateTimeline', () => {
  it('turns the placeholder into the first page', () => {
    const page = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: true };
    const e = revalidateTimeline(undefined, CH, page, 50, timelineMark());
    expect(ids(e)).toEqual(['m1', 'm2']);
    expect(e.loaded).toBe(true);
    expect(e.fetchedAt).toBe(50);
    expect(e.timeline.hasMoreOlder).toBe(true);
  });

  it('lets the fresh rows win, so an edit made while away shows', () => {
    const prev = cached([msg('m1', 1, { body: 'old' })]);
    const page = { messages: [msg('m1', 1, { body: 'new' })], hasMore: false };
    expect(
      revalidateTimeline(prev, CH, page, 2, timelineMark()).timeline.messages[0]
        .body
    ).toBe('new');
  });

  it('keeps the held details until the details fetch replaces them', () => {
    const prev = cached([
      msg('m1', 1, { reactions: [heart], attachments: [file], thread }),
    ]);
    const page = { messages: [msg('m1', 1)], hasMore: false };
    const [m] = revalidateTimeline(prev, CH, page, 2, timelineMark()).timeline
      .messages;
    expect(m.reactions).toEqual([heart]);
    expect(m.attachments).toEqual([file]);
    expect(m.thread).toEqual(thread);
  });

  it('keeps a message that arrived by realtime while the page was out', () => {
    const { entry, mark } = inFlight(cached([msg('m1', 1)]), [
      inserted(msg('live', 5)),
    ]);
    const page = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: false };
    expect(ids(revalidateTimeline(entry, CH, page, 2, mark))).toEqual([
      'm1',
      'm2',
      'live',
    ]);
  });

  it('keeps realtime arrivals held in the placeholder', () => {
    const { entry, mark } = inFlight(placeholderTimeline(CH), [
      inserted(msg('live', 5)),
    ]);
    const page = { messages: [msg('m1', 1)], hasMore: true };
    expect(ids(revalidateTimeline(entry, CH, page, 2, mark))).toEqual([
      'm1',
      'live',
    ]);
  });

  it('keeps an edit, a moderation delete and an erasure made in flight', () => {
    const held = [msg('m1', 1), msg('m2', 2), msg('m3', 3)];
    const { entry, mark } = inFlight(cached(held), [
      updated(msg('m1', 1, { body: 'edited', editedAt: at(8) })),
      updated(msg('m2', 2, { deletedAt: at(8), deletedBy: U })),
      updated(msg('m3', 3, { body: '[erased]', erasedAt: at(8) })),
    ]);
    // The page was read before the events: it still has the old rows.
    const page = { messages: held, hasMore: false };
    const [m1, m2, m3] = revalidateTimeline(entry, CH, page, 2, mark).timeline
      .messages;
    expect(m1.body).toBe('edited');
    expect(m2.deletedAt).toBe(at(8));
    expect(m2.deletedBy).toBe(U);
    expect(m3.body).toBe('[erased]');
  });

  it('keeps a hard delete made in flight', () => {
    const held = [msg('m1', 1), msg('m2', 2)];
    const { entry, mark } = inFlight(cached(held), [deleted('m2')]);
    const page = { messages: held, hasMore: false };
    expect(ids(revalidateTimeline(entry, CH, page, 2, mark))).toEqual(['m1']);
  });

  it('does not let an edit bring back a row the page lacks', () => {
    const { entry, mark } = inFlight(cached([msg('m1', 1), msg('m2', 2)]), [
      updated(msg('m2', 2, { body: 'edited' })),
    ]);
    const page = { messages: [msg('m1', 1)], hasMore: false };
    expect(ids(revalidateTimeline(entry, CH, page, 2, mark))).toEqual(['m1']);
  });

  it('empties the timeline on an empty page (RLS once access is lost)', () => {
    const { entry, mark } = inFlight(cached([msg('m1', 1), msg('m2', 2)]));
    const e = revalidateTimeline(
      entry,
      CH,
      { messages: [], hasMore: false },
      2,
      mark
    );
    expect(ids(e)).toEqual([]);
  });

  it('closes the fetch and trims the journal once the answer lands', () => {
    const { entry, mark } = inFlight(cached([]), [inserted(msg('m1', 1))]);
    const page = { messages: [], hasMore: false };
    const e = revalidateTimeline(entry, CH, page, 2, mark);
    expect(e.flights).toEqual([]);
    expect(e.journal).toEqual([]);
  });

  it('drops the answer of a fetch whose journal overflowed', () => {
    const { entry, mark } = inFlight(cached([msg('m1', 1, { body: 'old' })]));
    let e = entry;
    for (let i = 0; i <= TIMELINE_JOURNAL_MAX; i++)
      e = recordTimelineEvent(e, inserted(msg(`live${i}`, 10)));
    expect(e.journal.length).toBeLessThanOrEqual(TIMELINE_JOURNAL_MAX);
    const page = { messages: [msg('m1', 1, { body: 'new' })], hasMore: false };
    const out = revalidateTimeline(e, CH, page, 99, mark);
    // Not stored: the realtime-patched state stays, and so does the
    // fetch time, so the next show revalidates.
    expect(out.timeline).toBe(e.timeline);
    expect(out.fetchedAt).toBe(1);
    expect(out.flights).toEqual([]);
    expect(out.overflowed).toEqual([]);
  });

  it('drops older pages loaded before, which the page did not refresh', () => {
    const prev = cached([msg('old', 0), msg('m1', 1), msg('m2', 2)]);
    const page = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: true };
    const e = revalidateTimeline(prev, CH, page, 2, timelineMark());
    expect(ids(e)).toEqual(['m1', 'm2']);
    expect(e.timeline.hasMoreOlder).toBe(true);
  });

  it('ignores an entry held for another channel and stray rows', () => {
    const prev = { ...cached([msg('x', 1)]) };
    prev.timeline = { ...prev.timeline, channelId: OTHER };
    const page = {
      messages: [msg('m1', 1), msg('reply', 2, { threadRootId: 'm1' })],
      hasMore: false,
    };
    expect(ids(revalidateTimeline(prev, CH, page, 2, timelineMark()))).toEqual([
      'm1',
    ]);
  });
});

describe('applyTimelineDetails', () => {
  const none = {
    attachments: {},
    reactions: {},
    threads: {},
    cards: [],
    callCards: [],
  };

  it('fills in the details of the asked messages', () => {
    const e = applyTimelineDetails(
      cached([msg('m1', 1)]),
      ['m1'],
      {
        ...none,
        reactions: { m1: [heart] },
        attachments: { m1: [file] },
        threads: { m1: thread },
      },
      timelineMark()
    );
    const [m] = e.timeline.messages;
    expect(m.reactions).toEqual([heart]);
    expect(m.attachments).toEqual([file]);
    expect(m.thread).toEqual(thread);
  });

  it('treats a missing detail as none for an asked message', () => {
    const prev = cached([msg('m1', 1, { reactions: [heart], thread })]);
    const [m] = applyTimelineDetails(prev, ['m1'], none, timelineMark())
      .timeline.messages;
    expect(m.reactions).toEqual([]);
    expect(m.thread).toBeNull();
  });

  it('leaves messages it was not asked about alone', () => {
    const prev = cached([msg('m1', 1, { reactions: [heart] }), msg('m2', 2)]);
    const e = applyTimelineDetails(prev, ['m2'], none, timelineMark());
    expect(e.timeline.messages[0].reactions).toEqual([heart]);
  });

  it('adds shared cards by message', () => {
    const card = { messageId: 'm1' } as SharedCard;
    const e = applyTimelineDetails(
      cached([msg('m1', 1)]),
      ['m1'],
      { ...none, cards: [card] },
      timelineMark()
    );
    expect(e.cards).toEqual({ m1: card });
  });

  it('keeps a reaction recorded while the details were out', () => {
    const { entry, mark } = inFlight(cached([msg('m1', 1)]), [reacted('m1')]);
    // The answer was read before the reaction (the viewer's own toggle).
    const [m] = applyTimelineDetails(entry, ['m1'], none, mark).timeline
      .messages;
    expect(m.reactions).toEqual([heart]);
  });
});

describe('applyOlderPage', () => {
  it('adds the older rows and keeps a delete made in flight', () => {
    const { entry, mark } = inFlight(cached([msg('m2', 2), msg('m3', 3)]), [
      deleted('m1'),
    ]);
    const page = { messages: [msg('m0', 0), msg('m1', 1)], hasMore: true };
    const e = applyOlderPage(entry, page, mark);
    expect(ids(e)).toEqual(['m0', 'm2', 'm3']);
    expect(e.timeline.hasMoreOlder).toBe(true);
    expect(e.flights).toEqual([]);
  });
});

describe('the journal', () => {
  it('is kept only while a fetch is open', () => {
    const e = recordTimelineEvent(cached([]), inserted(msg('m1', 1)));
    expect(ids(e)).toEqual(['m1']);
    expect(e.journal).toEqual([]);
  });

  it('is kept for the oldest open fetch when another closes', () => {
    const a = inFlight(cached([]), [inserted(msg('m1', 1))]);
    const b = inFlight(a.entry, [inserted(msg('m2', 2))]);
    expect(endTimelineFetch(b.entry, b.mark).journal).toHaveLength(2);
    expect(endTimelineFetch(b.entry, a.mark).journal).toHaveLength(1);
  });
});

describe('timelineEventTargets', () => {
  const THIRD = 'c0000000-0000-4000-8000-000000000003';
  const listed = [CH, OTHER, THIRD];

  it('writes an insert or edit into its own channel only', () => {
    const ev = { type: 'insert' as const, message: msg('m1', 1) };
    expect(timelineEventTargets(ev, CH, listed)).toEqual({
      open: true,
      others: [],
    });
    expect(timelineEventTargets(ev, OTHER, listed)).toEqual({
      open: false,
      others: [CH],
    });
  });

  it('writes a delete, which names no channel, into every listed one', () => {
    expect(
      timelineEventTargets({ type: 'delete', id: 'm1' }, CH, listed)
    ).toEqual({ open: true, others: [OTHER, THIRD] });
  });

  it('keeps a row deleted during a prefetch of another channel away', () => {
    // Viewing OTHER while CH's hover prefetch is in flight; its page
    // was read before m1 was hard-deleted.
    const flight = inFlight(cached([msg('m1', 1), msg('m2', 2)]));
    let entry = flight.entry;
    const ev = { type: 'delete' as const, id: 'm1' };
    for (const id of timelineEventTargets(ev, OTHER, [CH, OTHER]).others) {
      if (id === CH)
        entry = recordTimelineEvent(entry, { kind: 'message', event: ev });
    }
    const stale = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: false };
    expect(ids(revalidateTimeline(entry, CH, stale, 2, flight.mark))).toEqual([
      'm2',
    ]);
  });
});

describe('droppedChannelIds', () => {
  it('lists channels that left the list', () => {
    expect(
      droppedChannelIds([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])
    ).toEqual(['a']);
  });

  it('lists nothing before both lists are known', () => {
    expect(droppedChannelIds(null, [{ id: 'a' }])).toEqual([]);
    expect(droppedChannelIds([{ id: 'a' }], undefined)).toEqual([]);
  });
});

describe('shouldPrefetchTimeline', () => {
  it('fetches when nothing or only the placeholder is held', () => {
    expect(shouldPrefetchTimeline(undefined, 0)).toBe(true);
    expect(shouldPrefetchTimeline(placeholderTimeline(CH), 0)).toBe(true);
  });

  it('skips a page fetched moments ago', () => {
    const e = cached([], { fetchedAt: 1_000 });
    expect(
      shouldPrefetchTimeline(e, 1_000 + TIMELINE_PREFETCH_FRESH_MS - 1)
    ).toBe(false);
    expect(shouldPrefetchTimeline(e, 1_000 + TIMELINE_PREFETCH_FRESH_MS)).toBe(
      true
    );
  });
});

describe('optimisticActiveId', () => {
  const clicked: PendingChannelNav = { channelId: OTHER, routeAtClick: CH };

  it('highlights the clicked row before the route lands', () => {
    expect(optimisticActiveId(clicked, CH)).toBe(OTHER);
    expect(isNavSettled(clicked, CH)).toBe(false);
  });

  it('follows the route once it has moved', () => {
    expect(isNavSettled(clicked, OTHER)).toBe(true);
    expect(optimisticActiveId(clicked, OTHER)).toBe(OTHER);
    // Moved somewhere else (a link elsewhere, the back button).
    expect(optimisticActiveId(clicked, null)).toBeNull();
  });

  it('is the route with nothing clicked', () => {
    expect(optimisticActiveId(null, CH)).toBe(CH);
    expect(isNavSettled(null, CH)).toBe(false);
  });

  it('works from a screen with no channel open', () => {
    const fromSaved = { channelId: CH, routeAtClick: null };
    expect(optimisticActiveId(fromSaved, null)).toBe(CH);
    expect(isNavSettled(fromSaved, CH)).toBe(true);
  });
});
