/**
 * A channel's timeline as kept in the session cache
 * (`lib/session-cache.ts`), so reopening a channel shows what the user
 * last saw at once while the newest page is fetched again behind it.
 *
 * The entry is the single copy of the timeline: the open channel's hook
 * renders it, and every change (a page, its details, a realtime event,
 * a reaction toggle) is written into it. Pure, so the merge rules are
 * tested here rather than discovered in the browser.
 */
import { sessionKey, type SessionKey } from '@/lib/session-cache';

import {
  compareMessages,
  createTimeline,
  mergeMessage,
  type TimelineState,
} from './message-list';
import type {
  ChatAttachment,
  ChatMessage,
  MessagePage,
  ReactionSummary,
  SharedCallCard,
  SharedCard,
  ThreadSummary,
} from './types';

export interface CachedTimeline {
  timeline: TimelineState;
  cards: Record<string, SharedCard>;
  callCards: Record<string, SharedCallCard>;
  /** False for the placeholder held until the first page lands. */
  loaded: boolean;
  /** Epoch ms the newest page was last fetched; null before that. */
  fetchedAt: number | null;
}

/** A hover within this long of the last fetch does not fetch again. */
export const TIMELINE_PREFETCH_FRESH_MS = 15_000;

export function timelineCacheKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  channelId: string
): SessionKey | null {
  return sessionKey(accountId, userId, `chat:timeline:${channelId}`);
}

/**
 * The entry held while the first page is in flight: not shown (the
 * skeleton is), but realtime events land in it, so a message posted
 * during the fetch is not lost when the page arrives.
 */
export function placeholderTimeline(channelId: string): CachedTimeline {
  return {
    timeline: createTimeline(channelId),
    cards: {},
    callCards: {},
    loaded: false,
    fetchedAt: null,
  };
}

/**
 * The newest page (rows only, no details yet) merged over what the
 * entry holds. The page is the window from now on: its rows win, so an
 * edit or delete made while the channel was closed shows, and older
 * pages loaded earlier are dropped rather than kept unrefreshed. A
 * message newer than the page's newest is kept — it arrived by realtime
 * while the page was in flight. Details (attachments, reactions,
 * threads) carry over from the held copy until the next details fetch
 * replaces them, so a revisit never flashes them away.
 */
export function revalidateTimeline(
  prev: CachedTimeline | undefined,
  channelId: string,
  page: MessagePage,
  now: number
): CachedTimeline {
  const base =
    prev && prev.timeline.channelId === channelId
      ? prev
      : placeholderTimeline(channelId);
  const held = new Map(base.timeline.messages.map((m) => [m.id, m]));
  const rows = page.messages.filter(
    (m) => m.channelId === channelId && m.threadRootId === null
  );
  const newest = rows[rows.length - 1];
  const inPage = new Set(rows.map((m) => m.id));
  const arrived = base.timeline.messages.filter(
    (m) => !inPage.has(m.id) && (!newest || compareMessages(m, newest) > 0)
  );
  const merged = rows.map((m) => {
    const old = held.get(m.id);
    return old ? mergeMessage(old, m) : m;
  });
  return {
    ...base,
    timeline: {
      ...base.timeline,
      messages: [...merged, ...arrived].sort(compareMessages),
      hasMoreOlder: page.hasMore,
    },
    loaded: true,
    fetchedAt: now,
  };
}

/**
 * Details fetched for `ids`, applied to the messages the entry still
 * holds. They are the whole answer for those ids: one with no
 * attachments, reactions or replies in the result has none (a reaction
 * removed while the channel was closed must go). Cards are added.
 */
export function applyTimelineDetails(
  entry: CachedTimeline,
  ids: readonly string[],
  details: {
    attachments: Record<string, ChatAttachment[]>;
    reactions: Record<string, ReactionSummary[]>;
    threads: Record<string, ThreadSummary>;
    cards: readonly SharedCard[];
    callCards: readonly SharedCallCard[];
  }
): CachedTimeline {
  const asked = new Set(ids);
  const messages = entry.timeline.messages.map((m): ChatMessage => {
    if (!asked.has(m.id) || m.deletedAt) return m;
    return {
      ...m,
      attachments: details.attachments[m.id] ?? [],
      reactions: details.reactions[m.id] ?? [],
      thread: details.threads[m.id] ?? null,
    };
  });
  const cards = { ...entry.cards };
  for (const c of details.cards) cards[c.messageId] = c;
  const callCards = { ...entry.callCards };
  for (const c of details.callCards) callCards[c.messageId] = c;
  return {
    ...entry,
    timeline: { ...entry.timeline, messages },
    cards,
    callCards,
  };
}

/** Whether a hover should fetch the newest page (not when it just was). */
export function shouldPrefetchTimeline(
  entry: CachedTimeline | undefined,
  now: number
): boolean {
  if (!entry?.loaded || entry.fetchedAt === null) return true;
  return now - entry.fetchedAt >= TIMELINE_PREFETCH_FRESH_MS;
}
