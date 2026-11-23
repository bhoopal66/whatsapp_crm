/**
 * A channel's timeline as kept in the session cache
 * (`lib/session-cache.ts`), so reopening a channel shows what the user
 * last saw at once while the newest page is fetched again behind it.
 *
 * The entry is the single copy of the timeline: the open channel's hook
 * renders it, and every change (a page, its details, a realtime event,
 * a reaction toggle) is written into it. Pure but for the tab's mark
 * counter, so the merge rules are tested here rather than discovered in
 * the browser.
 */
import { sessionKey, type SessionKey } from '@/lib/session-cache';

import {
  applyMessageEvent,
  applyReactionEvent,
  compareMessages,
  createTimeline,
  mergeMessage,
  mergePage,
  type MessageEvent,
  type ReactionEvent,
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

/** A change written into an entry: a realtime event or a reaction toggle. */
export type TimelineEvent =
  | { kind: 'message'; event: MessageEvent }
  | { kind: 'reaction'; event: ReactionEvent };

interface JournalItem {
  seq: number;
  event: TimelineEvent;
}

export interface CachedTimeline {
  timeline: TimelineState;
  cards: Record<string, SharedCard>;
  callCards: Record<string, SharedCallCard>;
  /** False for the placeholder held until the first page lands. */
  loaded: boolean;
  /** Epoch ms the newest page was last fetched; null before that. */
  fetchedAt: number | null;
  /**
   * The events written into the entry while a fetch for it is open,
   * oldest first. An answer is a snapshot taken at some unknown point of
   * its flight, so it is merged and then these events are replayed over
   * it: each one is a full row or an idempotent operation, so the replay
   * is right whichever point that was. Without it an edit, a moderation
   * delete or an erasure made during the flight was undone by the page.
   */
  journal: readonly JournalItem[];
  /** The mark (`timelineMark`) each open fetch started at. */
  flights: readonly number[];
  /**
   * Open fetches whose events no longer all fit in the journal
   * (`TIMELINE_JOURNAL_MAX`). Their answer is not stored: the entry
   * keeps its realtime-patched state and the next show revalidates.
   */
  overflowed: readonly number[];
}

/** The most events the journal holds; older ones overflow their fetch. */
export const TIMELINE_JOURNAL_MAX = 500;

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
    journal: [],
    flights: [],
    overflowed: [],
  };
}

// One counter for the tab, so a mark never matches a fetch of an entry
// that was dropped and created again meanwhile.
let clock = 0;

/** The mark a fetch starts at: every event recorded after it is newer. */
export function timelineMark(): number {
  return ++clock;
}

/** Open a fetch at `mark`; events from now on are journaled for it. */
export function beginTimelineFetch(
  entry: CachedTimeline,
  mark: number
): CachedTimeline {
  return { ...entry, flights: [...entry.flights, mark] };
}

/** Close the fetch at `mark` (also for a failed one) and trim the journal. */
export function endTimelineFetch(
  entry: CachedTimeline,
  mark: number
): CachedTimeline {
  return trimJournal({
    ...entry,
    flights: entry.flights.filter((f) => f !== mark),
    overflowed: entry.overflowed.filter((f) => f !== mark),
  });
}

/** Drop journal items no open, non-overflowed fetch will replay. */
function trimJournal(entry: CachedTimeline): CachedTimeline {
  const live = entry.flights.filter((f) => !entry.overflowed.includes(f));
  const floor = live.length ? Math.min(...live) : Infinity;
  const journal = entry.journal.filter((j) => j.seq > floor);
  return journal.length === entry.journal.length
    ? entry
    : { ...entry, journal };
}

/** Whether the fetch at `mark` lost events to the cap. */
function isOverflowed(entry: CachedTimeline, mark: number): boolean {
  return entry.overflowed.includes(mark);
}

function applyEvent(t: TimelineState, e: TimelineEvent): TimelineState {
  return e.kind === 'message'
    ? applyMessageEvent(t, e.event)
    : applyReactionEvent(t, e.event);
}

/**
 * Apply an event to the entry and, while a fetch is open, journal it.
 * It is journaled even when it changes nothing now: a reaction to a
 * message the placeholder does not hold yet applies once the page does.
 */
export function recordTimelineEvent(
  entry: CachedTimeline,
  event: TimelineEvent
): CachedTimeline {
  const timeline = applyEvent(entry.timeline, event);
  if (!entry.flights.some((f) => !isOverflowed(entry, f)))
    return timeline === entry.timeline ? entry : { ...entry, timeline };
  const journal = [...entry.journal, { seq: timelineMark(), event }];
  if (journal.length <= TIMELINE_JOURNAL_MAX)
    return { ...entry, timeline, journal };
  // Over the cap: the oldest items go, and every fetch that would have
  // replayed one of them can no longer be made right.
  const cut = journal.length - TIMELINE_JOURNAL_MAX;
  const lost = journal[cut - 1].seq;
  const overflowed = [
    ...entry.overflowed,
    ...entry.flights.filter((f) => f < lost && !entry.overflowed.includes(f)),
  ];
  return trimJournal({
    ...entry,
    timeline,
    journal: journal.slice(cut),
    overflowed,
  });
}

/**
 * Which cached timelines a realtime message event is written into: the
 * open channel's (`open`) and the other channels' entries (`others`,
 * each a no-op when the channel has no entry). An insert or edit names
 * its channel. A delete names none, so it goes to the open channel and
 * to every other listed one: a hover prefetch of another channel may
 * be in flight with a snapshot taken before the delete, and only the
 * journal keeps that row from coming back. A delete only removes a row
 * (realtime does not RLS-filter it), so writing it everywhere can never
 * reveal anything.
 */
export function timelineEventTargets(
  event: MessageEvent,
  openChannelId: string,
  listedChannelIds: readonly string[]
): { open: boolean; others: string[] } {
  if (event.type === 'delete') {
    return {
      open: true,
      others: listedChannelIds.filter((id) => id !== openChannelId),
    };
  }
  const channelId = event.message.channelId;
  return channelId === openChannelId
    ? { open: true, others: [] }
    : { open: false, others: [channelId] };
}

/**
 * The events since `mark`, in order, over an answer. An edit never adds
 * a row: a row the answer does not hold is one it cannot vouch for (or
 * one outside the window), and an insert in the journal brings the rows
 * created during the flight.
 */
function replaySince(
  t: TimelineState,
  journal: readonly JournalItem[],
  mark: number
): TimelineState {
  let out = t;
  for (const { seq, event } of journal) {
    if (seq <= mark) continue;
    if (event.kind === 'message' && isUnheldEdit(out, event.event)) continue;
    out = applyEvent(out, event);
  }
  return out;
}

function isUnheldEdit(t: TimelineState, e: MessageEvent): boolean {
  return (
    e.type === 'update' &&
    e.message.threadRootId === t.threadRootId &&
    !t.messages.some((m) => m.id === e.message.id)
  );
}

/**
 * The newest page (rows only, no details yet) as the window from now
 * on, with the events recorded since `mark` replayed over it. Its rows
 * win over the held copy, so an edit or delete made while the channel
 * was closed shows; an event during the flight wins over the rows. A
 * held message the page does not have is dropped unless the journal
 * brings it: older pages loaded earlier are re-read on scroll, and an
 * empty page (RLS once access is lost) is the whole answer. Details
 * (attachments, reactions, threads) carry over from the held copy until
 * the next details fetch replaces them, so a revisit never flashes them
 * away. The answer of a fetch that overflowed the journal is dropped.
 *
 * `keepOlder` (a re-read of an open channel after a gap) keeps the held
 * messages below the page, so a reader scrolled up to them is not moved,
 * but only when the page's oldest row is held too: otherwise rows were
 * missed between the two, and the window starts over.
 */
export function revalidateTimeline(
  prev: CachedTimeline | undefined,
  channelId: string,
  page: MessagePage,
  now: number,
  mark: number,
  { keepOlder = false }: { keepOlder?: boolean } = {}
): CachedTimeline {
  const base =
    prev && prev.timeline.channelId === channelId
      ? prev
      : placeholderTimeline(channelId);
  if (isOverflowed(base, mark)) return endTimelineFetch(base, mark);
  const held = new Map(base.timeline.messages.map((m) => [m.id, m]));
  const rows = page.messages
    .filter((m) => m.channelId === channelId && m.threadRootId === null)
    .map((m) => {
      const old = held.get(m.id);
      return old ? mergeMessage(old, m) : m;
    });
  rows.sort(compareMessages);
  const oldest = rows[0];
  const older =
    keepOlder && oldest && held.has(oldest.id)
      ? base.timeline.messages.filter((m) => compareMessages(m, oldest) < 0)
      : [];
  const fresh: TimelineState = {
    ...base.timeline,
    messages: [...older, ...rows],
    hasMoreOlder: older.length ? base.timeline.hasMoreOlder : page.hasMore,
  };
  return {
    ...endTimelineFetch(base, mark),
    timeline: replaySince(fresh, base.journal, mark),
    loaded: true,
    fetchedAt: now,
  };
}

/** An older page added below the window, then the events since `mark`. */
export function applyOlderPage(
  entry: CachedTimeline,
  page: MessagePage,
  mark: number
): CachedTimeline {
  if (isOverflowed(entry, mark)) return endTimelineFetch(entry, mark);
  return {
    ...endTimelineFetch(entry, mark),
    timeline: replaySince(mergePage(entry.timeline, page), entry.journal, mark),
  };
}

/**
 * Details fetched for `ids`, applied to the messages the entry still
 * holds, then the events since `mark` replayed (a reaction added during
 * the flight, the viewer's own toggle included, is not in the answer).
 * They are the whole answer for those ids: one with no attachments,
 * reactions or replies in the result has none (a reaction removed while
 * the channel was closed must go). Cards are added.
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
  },
  mark: number
): CachedTimeline {
  if (isOverflowed(entry, mark)) return endTimelineFetch(entry, mark);
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
    ...endTimelineFetch(entry, mark),
    timeline: replaySince({ ...entry.timeline, messages }, entry.journal, mark),
    cards,
    callCards,
  };
}

/**
 * Channels in `prev` that `next` no longer lists: the member was
 * removed, a 159 audience left them out, or a guest's bank was switched
 * off. RLS answers their timelines with nothing, so their entries go.
 */
export function droppedChannelIds(
  prev: readonly { id: string }[] | null | undefined,
  next: readonly { id: string }[] | null | undefined
): string[] {
  if (!prev || !next) return [];
  const listed = new Set(next.map((c) => c.id));
  return prev.filter((c) => !listed.has(c.id)).map((c) => c.id);
}

/** Whether a hover should fetch the newest page (not when it just was). */
export function shouldPrefetchTimeline(
  entry: CachedTimeline | undefined,
  now: number
): boolean {
  if (!entry?.loaded || entry.fetchedAt === null) return true;
  return now - entry.fetchedAt >= TIMELINE_PREFETCH_FRESH_MS;
}
