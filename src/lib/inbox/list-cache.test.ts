import { beforeEach, describe, expect, it } from 'vitest';

import {
  inboxListCacheKey,
  inboxListQuestion,
  writeThroughInboxList,
  type InboxListQuestion,
  type InboxListSnapshot,
} from './list-cache';
import { resetSessionCacheForTests, sessionCache } from '@/lib/session-cache';

const BASE: InboxListQuestion = {
  teamView: false,
  campaignOnly: false,
  aiLive: true,
  restrictToUserId: null,
  restrictToChannelIds: [],
  restrictToConversationIds: [],
  status: 'all',
  chatTagIds: [],
  assignee: null,
  campaignId: null,
  insightFilters: [],
};

describe('inboxListQuestion', () => {
  it('starts with the inbox:list: prefix', () => {
    expect(inboxListQuestion(BASE).startsWith('inbox:list:')).toBe(true);
  });

  // Every input of the server query, and the view, changes the key.
  const variants: [string, Partial<InboxListQuestion>][] = [
    ['team view', { teamView: true }],
    ['campaign inbox', { campaignOnly: true }],
    ['AI live', { aiLive: false }],
    ['personal scope', { restrictToUserId: 'u1' }],
    ['allocated numbers', { restrictToChannelIds: ['ch1'] }],
    ['shared chats', { restrictToConversationIds: ['c1'] }],
    ['unread', { status: 'unread' }],
    ['chat tag', { chatTagIds: ['t1'] }],
    ['assignee', { assignee: 'u2' }],
    ['unassigned', { assignee: 'unassigned' }],
    ['campaign', { campaignId: 'b1' }],
    ['insight filter', { insightFilters: ['hot'] }],
  ];

  it.each(variants)('names the %s', (_label, change) => {
    expect(inboxListQuestion({ ...BASE, ...change })).not.toBe(
      inboxListQuestion(BASE)
    );
  });

  it('gives every variant its own key', () => {
    const keys = new Set(
      variants.map(([, change]) => inboxListQuestion({ ...BASE, ...change }))
    );
    expect(keys.size).toBe(variants.length);
  });

  it('ignores the order of id lists', () => {
    expect(
      inboxListQuestion({
        ...BASE,
        chatTagIds: ['b', 'a'],
        restrictToChannelIds: ['y', 'x'],
        restrictToConversationIds: ['2', '1'],
        insightFilters: ['upset', 'hot'],
      })
    ).toBe(
      inboxListQuestion({
        ...BASE,
        chatTagIds: ['a', 'b'],
        restrictToChannelIds: ['x', 'y'],
        restrictToConversationIds: ['1', '2'],
        insightFilters: ['hot', 'upset'],
      })
    );
  });

  it('keeps values from running into each other', () => {
    expect(inboxListQuestion({ ...BASE, chatTagIds: ['a,b'] })).not.toBe(
      inboxListQuestion({ ...BASE, chatTagIds: ['a', 'b'] })
    );
  });
});

describe('inboxListCacheKey', () => {
  it('is null until account and user are known', () => {
    expect(inboxListCacheKey(null, 'u', BASE)).toBeNull();
    expect(inboxListCacheKey('a', undefined, BASE)).toBeNull();
  });

  it('is per account and per user', () => {
    const k = inboxListCacheKey('a', 'u', BASE);
    expect(inboxListCacheKey('a2', 'u', BASE)).not.toBe(k);
    expect(inboxListCacheKey('a', 'u2', BASE)).not.toBe(k);
  });
});

describe('writeThroughInboxList', () => {
  beforeEach(() => resetSessionCacheForTests());

  const key = inboxListCacheKey('a', 'u', BASE)!;
  const other = inboxListCacheKey('a', 'u', { ...BASE, status: 'unread' })!;
  const snap = (ids: string[]): InboxListSnapshot<{ id: string }> => ({
    rows: ids.map((id) => ({ id })),
    cursor: null,
  });

  it("stores the rows on screen when they are the view's rows", () => {
    sessionCache.set(key, snap(['1']));
    // A realtime patch the Inbox applied: a new chat on top.
    expect(writeThroughInboxList(key, key, snap(['2', '1']))).toBe(true);
    expect(
      sessionCache.peek<InboxListSnapshot<{ id: string }>>(key)?.value.rows
    ).toEqual([{ id: '2' }, { id: '1' }]);
  });

  it("never stores the previous view's rows under a new key", () => {
    sessionCache.set(key, snap(['1']));
    // Filter just changed to `key`; the screen still shows `other`'s rows.
    expect(writeThroughInboxList(key, other, snap(['9']))).toBe(false);
    expect(
      sessionCache.peek<InboxListSnapshot<{ id: string }>>(key)?.value.rows
    ).toEqual([{ id: '1' }]);
  });

  it('does not put back an entry the cache dropped (sign-out, switch)', () => {
    expect(writeThroughInboxList(key, key, snap(['1']))).toBe(false);
    expect(sessionCache.peek(key)).toBeUndefined();
  });

  it('does nothing without a key', () => {
    expect(writeThroughInboxList(null, null, snap(['1']))).toBe(false);
  });
});
