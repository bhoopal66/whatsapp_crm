import { describe, expect, it } from 'vitest';

import { sessionKey } from '@/lib/session-cache';

import {
  isNavSettled,
  optimisticActiveId,
  type PendingChannelNav,
} from '../sidebar-nav';
import {
  applyTimelineDetails,
  placeholderTimeline,
  revalidateTimeline,
  shouldPrefetchTimeline,
  timelineCacheKey,
  TIMELINE_PREFETCH_FRESH_MS,
  type CachedTimeline,
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
    const e = revalidateTimeline(undefined, CH, page, 50);
    expect(ids(e)).toEqual(['m1', 'm2']);
    expect(e.loaded).toBe(true);
    expect(e.fetchedAt).toBe(50);
    expect(e.timeline.hasMoreOlder).toBe(true);
  });

  it('lets the fresh rows win, so an edit made while away shows', () => {
    const prev = cached([msg('m1', 1, { body: 'old' })]);
    const page = { messages: [msg('m1', 1, { body: 'new' })], hasMore: false };
    expect(
      revalidateTimeline(prev, CH, page, 2).timeline.messages[0].body
    ).toBe('new');
  });

  it('keeps the held details until the details fetch replaces them', () => {
    const prev = cached([
      msg('m1', 1, { reactions: [heart], attachments: [file], thread }),
    ]);
    const page = { messages: [msg('m1', 1)], hasMore: false };
    const [m] = revalidateTimeline(prev, CH, page, 2).timeline.messages;
    expect(m.reactions).toEqual([heart]);
    expect(m.attachments).toEqual([file]);
    expect(m.thread).toEqual(thread);
  });

  it('keeps a message that arrived by realtime while the page was out', () => {
    const prev = cached([msg('m1', 1), msg('live', 5)]);
    const page = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: false };
    expect(ids(revalidateTimeline(prev, CH, page, 2))).toEqual([
      'm1',
      'm2',
      'live',
    ]);
  });

  it('keeps realtime arrivals held in the placeholder', () => {
    const prev = {
      ...placeholderTimeline(CH),
      timeline: {
        ...placeholderTimeline(CH).timeline,
        messages: [msg('live', 5)],
      },
    };
    const page = { messages: [msg('m1', 1)], hasMore: true };
    expect(ids(revalidateTimeline(prev, CH, page, 2))).toEqual(['m1', 'live']);
  });

  it('drops older pages loaded before, which the page did not refresh', () => {
    const prev = cached([msg('old', 0), msg('m1', 1), msg('m2', 2)]);
    const page = { messages: [msg('m1', 1), msg('m2', 2)], hasMore: true };
    const e = revalidateTimeline(prev, CH, page, 2);
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
    expect(ids(revalidateTimeline(prev, CH, page, 2))).toEqual(['m1']);
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
    const e = applyTimelineDetails(cached([msg('m1', 1)]), ['m1'], {
      ...none,
      reactions: { m1: [heart] },
      attachments: { m1: [file] },
      threads: { m1: thread },
    });
    const [m] = e.timeline.messages;
    expect(m.reactions).toEqual([heart]);
    expect(m.attachments).toEqual([file]);
    expect(m.thread).toEqual(thread);
  });

  it('treats a missing detail as none for an asked message', () => {
    const prev = cached([msg('m1', 1, { reactions: [heart], thread })]);
    const [m] = applyTimelineDetails(prev, ['m1'], none).timeline.messages;
    expect(m.reactions).toEqual([]);
    expect(m.thread).toBeNull();
  });

  it('leaves messages it was not asked about alone', () => {
    const prev = cached([msg('m1', 1, { reactions: [heart] }), msg('m2', 2)]);
    const e = applyTimelineDetails(prev, ['m2'], none);
    expect(e.timeline.messages[0].reactions).toEqual([heart]);
  });

  it('adds shared cards by message', () => {
    const card = { messageId: 'm1' } as SharedCard;
    const e = applyTimelineDetails(cached([msg('m1', 1)]), ['m1'], {
      ...none,
      cards: [card],
    });
    expect(e.cards).toEqual({ m1: card });
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
