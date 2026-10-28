import type {
  EventFeedItem,
  FeedItem,
  MeetingFeedItem,
} from '@/lib/calendar/feed';
import {
  timestampToWallArray,
  wallArrayToTimestamp,
} from '@/lib/calendar/fc-timezone';
import { itemEndMs, itemStartMs } from '@/lib/calendar/ui/item-time';

// ------------------------------------------------------------
// The home "Today's agenda" panel: the calendar feed's events and
// meetings, split into today's and the next one after today. Tasks are
// left out (the tasks panel lists them). Pure: the caller passes the
// clock and the zone.
// ------------------------------------------------------------

/** A meeting's Join link opens this long before its start. */
export const JOIN_LEAD_MS = 10 * 60_000;
/** How far ahead the panel reads, from the start of today. */
export const AGENDA_DAYS = 7;

export type AgendaItem = EventFeedItem | MeetingFeedItem;

export interface AgendaEntry {
  item: AgendaItem;
  startMs: number;
  endMs: number;
  state: 'past' | 'now' | 'upcoming';
  /** The meeting to join now (from 10 minutes before its start until its end). */
  joinMeetingId: string | null;
}

export interface Agenda {
  /** Today's items, in time order (all-day first at the same instant). */
  today: AgendaEntry[];
  /** Today's items not yet over. */
  leftToday: number;
  /** The first item that starts after today, if any. */
  next: AgendaEntry | null;
  /** Nothing today and nothing in the rest of the range. */
  empty: boolean;
}

/** Midnight of `nowMs`'s day in `zone`, `days` days on. */
export function zoneDayStart(nowMs: number, zone: string, days = 0): number {
  const [y, m, d] = timestampToWallArray(zone, nowMs);
  return wallArrayToTimestamp(zone, [y, m, d + days, 0, 0, 0, 0]);
}

/** The feed range the panel asks for: [start of today, +7 days). */
export function agendaRange(
  nowMs: number,
  zone: string
): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(zoneDayStart(nowMs, zone)).toISOString(),
    toIso: new Date(zoneDayStart(nowMs, zone, AGENDA_DAYS)).toISOString(),
  };
}

function entryFor(item: AgendaItem, nowMs: number, zone: string): AgendaEntry {
  const startMs = itemStartMs(item, zone);
  const endMs = Math.max(startMs, itemEndMs(item, zone));
  const ended = item.kind === 'meeting' && item.status === 'ended';
  const state: AgendaEntry['state'] =
    ended || (endMs > startMs ? endMs <= nowMs : startMs <= nowMs)
      ? 'past'
      : startMs <= nowMs
        ? 'now'
        : 'upcoming';
  const joinable =
    item.kind === 'meeting' &&
    item.status === 'scheduled' &&
    nowMs >= startMs - JOIN_LEAD_MS &&
    nowMs < endMs;
  return {
    item,
    startMs,
    endMs,
    state,
    joinMeetingId: joinable ? item.id : null,
  };
}

/**
 * Today's agenda out of the feed. Tasks and invitations the person
 * declined are left out; an ended meeting reads as past.
 */
export function agendaFor(
  items: readonly FeedItem[],
  nowMs: number,
  zone: string
): Agenda {
  const todayStart = zoneDayStart(nowMs, zone);
  const tomorrow = zoneDayStart(nowMs, zone, 1);
  const entries = items
    .filter(
      (i): i is AgendaItem =>
        i.kind === 'meeting' ||
        (i.kind === 'event' && i.myResponse !== 'declined')
    )
    .map((i) => entryFor(i, nowMs, zone))
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        Number(b.item.allDay) - Number(a.item.allDay) ||
        a.item.title.localeCompare(b.item.title)
    );
  const today = entries.filter(
    (e) =>
      e.startMs < tomorrow &&
      (e.endMs > todayStart ||
        (e.endMs === e.startMs && e.startMs >= todayStart))
  );
  const next = entries.find((e) => e.startMs >= tomorrow) ?? null;
  return {
    today,
    leftToday: today.filter((e) => e.state !== 'past').length,
    next,
    empty: today.length === 0 && next === null,
  };
}
