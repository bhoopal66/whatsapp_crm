// Drag and resize → the PATCH that saves it — pure.
//
// FullCalendar hands back instants (all-day: midnight in the calendar's
// zone). An event keeps its own all-day flag and zone; an all-day one is
// saved as dates read in the calendar's zone, which is where they were
// shown. Moving a whole series shifts its first occurrence by the same
// wall-clock change as the dragged one, so a weekly 10:00 dragged to
// 11:00 is 11:00 on both sides of a DST change.

import type { FeedItem } from '../feed';
import { fromFloating, toFloating } from '../recurrence';
import { dateKeyInZone } from './event-form';
import { addDaysToKey } from './mini-month';

export interface SeriesRow {
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
}

const DAY = 86_400_000;
const dayIndex = (key: string) => Date.parse(`${key}T00:00:00Z`) / DAY;

/** Whole days from one date key to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round(dayIndex(to) - dayIndex(from));
}

/** Meetings PATCH: scheduledStart / scheduledEnd, keeping the length. */
export function meetingDragBody(
  item: FeedItem,
  newStart: Date,
  newEnd: Date | null
): { scheduledStart: string; scheduledEnd: string } {
  const length = Date.parse(item.end) - Date.parse(item.start);
  const end = newEnd ? newEnd.getTime() : newStart.getTime() + length;
  return {
    scheduledStart: newStart.toISOString(),
    scheduledEnd: new Date(end).toISOString(),
  };
}

/** The dragged occurrence's new start and end, as the API takes them. */
function occurrenceTimes(
  item: FeedItem,
  newStart: Date,
  newEnd: Date | null,
  calendarZone: string
): { start: string; end: string } {
  if (item.allDay) {
    const start = dateKeyInZone(newStart.getTime(), calendarZone);
    const end = newEnd
      ? dateKeyInZone(newEnd.getTime(), calendarZone)
      : addDaysToKey(start, Math.max(1, daysBetween(item.start, item.end)));
    return { start, end };
  }
  const length = Date.parse(item.end) - Date.parse(item.start);
  const end = newEnd ? newEnd.getTime() : newStart.getTime() + length;
  return { start: newStart.toISOString(), end: new Date(end).toISOString() };
}

/**
 * Calendar event PATCH body. `scope` matters only for a recurring item:
 * 'this' moves one occurrence, 'all' shifts the series.
 */
export function eventDragBody(
  item: FeedItem,
  series: SeriesRow,
  newStart: Date,
  newEnd: Date | null,
  scope: 'this' | 'all',
  calendarZone: string
): Record<string, unknown> {
  const occ = occurrenceTimes(item, newStart, newEnd, calendarZone);
  const fixed = { allDay: series.all_day, timeZone: series.time_zone };
  const recurring = item.kind === 'event' && item.recurring;
  if (!recurring) return { ...occ, ...fixed };
  if (scope === 'this') {
    return {
      ...occ,
      ...fixed,
      scope: 'this',
      occurrenceStart: item.occurrenceStart,
    };
  }
  return { ...shiftSeries(item, occ, series), ...fixed, scope: 'all' };
}

/** The series' new first start and end after one occurrence moved. */
export function shiftSeries(
  item: Pick<FeedItem, 'start' | 'end' | 'allDay'>,
  moved: { start: string; end: string },
  series: SeriesRow
): { start: string; end: string } {
  const zone = series.time_zone;
  if (item.allDay) {
    const s = dateKeyInZone(Date.parse(series.start_at), zone);
    const e = dateKeyInZone(Date.parse(series.end_at), zone);
    return {
      start: addDaysToKey(s, daysBetween(item.start, moved.start)),
      end: addDaysToKey(e, daysBetween(item.end, moved.end)),
    };
  }
  const wall = (iso: string) => toFloating(Date.parse(iso), zone);
  const shift = (iso: string, by: number) =>
    new Date(fromFloating(wall(iso) + by, zone)).toISOString();
  return {
    start: shift(series.start_at, wall(moved.start) - wall(item.start)),
    end: shift(series.end_at, wall(moved.end) - wall(item.end)),
  };
}
