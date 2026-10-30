// ============================================================
// The latest page of each thread, kept in the session cache
// (`lib/session-cache.ts`) so reopening a chat shows its messages at
// once while the fresh page loads. Pure: the fetch lives in
// `message-page-fetch.ts`, the writes in the inbox page and thread.
//
// What is cached is the server's latest page as last read, patched by
// the realtime events the inbox already applies. Never an optimistic
// (`temp-`) bubble or an older page: those belong to one viewing.
// ============================================================

import type { Message, MessageReaction } from '@/types';
import { sessionKey, type SessionKey } from '@/lib/session-cache';
import {
  MESSAGE_PAGE_SIZE,
  dropUnconfirmed,
  mergeLatestMessages,
  replaceReactionsFor,
  splitEmbeddedReactions,
  toChronological,
  type MessageWithReactions,
} from '@/lib/inbox/pagination';

export interface CachedMessagePage {
  /** Chronological (oldest first). */
  messages: Message[];
  reactions: MessageReaction[];
  /** The page was full: there may be history above it. */
  hasOlder: boolean;
}

/** The cache key for one conversation's latest page. */
export function messagesCacheKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  conversationId: string | null | undefined
): SessionKey | null {
  if (!conversationId) return null;
  return sessionKey(accountId, userId, `inbox:messages:${conversationId}`);
}

/** A page read newest-first with reactions embedded, as cached. */
export function messagePageFromRows(
  rows: MessageWithReactions[],
  pageSize: number = MESSAGE_PAGE_SIZE
): CachedMessagePage {
  const { messages, reactions } = splitEmbeddedReactions(rows);
  return {
    messages: toChronological(messages),
    reactions,
    hasOlder: messages.length >= pageSize,
  };
}

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export type CacheEvent<T> = {
  eventType: string;
  new: T;
  old: Partial<T>;
};

/**
 * Apply a realtime `messages` event to a cached page. An insert is
 * placed by `created_at` (the stable sort keeps arrival order on ties);
 * a page that grows past `pageSize` drops its oldest rows, which then
 * count as history above it.
 */
export function applyMessageEventToPage(
  page: CachedMessagePage,
  event: CacheEvent<Message>,
  pageSize: number = MESSAGE_PAGE_SIZE
): CachedMessagePage {
  if (event.eventType === 'INSERT') {
    const row = event.new;
    if (!row?.id || row.id.startsWith('temp-')) return page;
    if (page.messages.some((m) => m.id === row.id)) return page;
    const all = [...page.messages, row]
      .map((m, i) => ({ m, i, t: time(m.created_at) }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((x) => x.m);
    if (all.length <= pageSize) return { ...page, messages: all };
    const kept = all.slice(all.length - pageSize);
    const keptIds = new Set(kept.map((m) => m.id));
    return {
      messages: kept,
      reactions: page.reactions.filter((r) => keptIds.has(r.message_id)),
      hasOlder: true,
    };
  }
  if (event.eventType === 'UPDATE') {
    const row = event.new;
    if (!row?.id || !page.messages.some((m) => m.id === row.id)) return page;
    return {
      ...page,
      messages: page.messages.map((m) =>
        m.id === row.id ? { ...m, ...row } : m
      ),
    };
  }
  if (event.eventType === 'DELETE') {
    const id = event.old?.id;
    if (!id || !page.messages.some((m) => m.id === id)) return page;
    return {
      ...page,
      messages: page.messages.filter((m) => m.id !== id),
      reactions: page.reactions.filter((r) => r.message_id !== id),
    };
  }
  return page;
}

/**
 * Apply a realtime `message_reactions` event to a cached page. Only
 * reactions on a message the page holds are kept.
 */
export function applyReactionEventToPage(
  page: CachedMessagePage,
  event: CacheEvent<MessageReaction>
): CachedMessagePage {
  if (event.eventType === 'INSERT' || event.eventType === 'UPDATE') {
    const row = event.new;
    if (!row?.id || !page.messages.some((m) => m.id === row.message_id)) {
      return page;
    }
    const others = page.reactions.filter((r) => r.id !== row.id);
    return { ...page, reactions: [...others, row] };
  }
  if (event.eventType === 'DELETE') {
    const id = event.old?.id;
    if (!id || !page.reactions.some((r) => r.id === id)) return page;
    return { ...page, reactions: page.reactions.filter((r) => r.id !== id) };
  }
  return page;
}

/**
 * Fold a freshly read latest page into a thread opened on its cached
 * page: messages through `mergeLatestMessages` (status ticks applied,
 * new rows appended, a `sending` bubble kept), the fetched page's
 * reactions replacing the held ones of those messages. A gap (more
 * arrived than one page) leaves history above the page.
 *
 * `held.shownBefore` names the rows the opening showed from the cache:
 * those the fresh page no longer contains are dropped first
 * (`dropUnconfirmed`), so a chat that became invisible, or a deleted
 * message, does not stay on screen.
 */
export function mergeFreshPage(
  held: {
    messages: Message[];
    reactions: MessageReaction[];
    shownBefore?: ReadonlySet<string>;
  },
  fresh: CachedMessagePage,
  pageSize: number = MESSAGE_PAGE_SIZE
): CachedMessagePage {
  const confirmed = held.shownBefore
    ? dropUnconfirmed(held.messages, fresh.messages, held.shownBefore, pageSize)
    : held.messages;
  const { messages, gap } = mergeLatestMessages(
    confirmed,
    fresh.messages,
    pageSize
  );
  return {
    messages,
    reactions: replaceReactionsFor(
      held.reactions,
      fresh.messages.map((m) => m.id),
      fresh.reactions
    ),
    hasOlder: gap || fresh.hasOlder,
  };
}
