// What the event popover prints — pure (locale and zone passed in).

import type { FeedItem } from '../feed';
import type { RepeatDescription, Weekday } from '../rrule-form';
import { WEEKDAYS } from '../rrule-form';
import { addDaysToKey } from './mini-month';

const keyDate = (key: string) => new Date(`${key}T00:00:00Z`);

/**
 * "Thu, 15 Oct, 10:00 – 11:00" in `zone`; all-day items as dates, the
 * end shown inclusive ("Thu, 15 Oct – Sat, 17 Oct"). A task is its due
 * moment alone.
 */
export function whenText(
  item: Pick<FeedItem, 'start' | 'end' | 'allDay'>,
  zone: string,
  locale: string
): string {
  if (item.allDay) {
    const fmt = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const last = addDaysToKey(item.end, -1);
    const end = last > item.start ? last : item.start;
    return end === item.start
      ? fmt.format(keyDate(item.start))
      : fmt.formatRange(keyDate(item.start), keyDate(end));
  }
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const start = new Date(item.start);
  const end = new Date(item.end);
  return end.getTime() > start.getTime()
    ? fmt.formatRange(start, end)
    : fmt.format(start);
}

// 2024-01-01 was a Monday.
const weekdayDate = (d: Weekday) =>
  new Date(Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(d)));

/**
 * The ICU values for `Calendar.repeat.<key>`: weekday and date names
 * already in `locale`, so the catalogue only arranges them.
 */
export function repeatValues(
  desc: RepeatDescription,
  locale: string
): Record<string, string | number> {
  const v = desc.values;
  const dayName = (d: Weekday, width: 'long' | 'short') =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: width }).format(
      weekdayDate(d)
    );
  const out: Record<string, string | number> = { interval: v.interval ?? 1 };
  if (v.weekdays) {
    out.days = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      v.weekdays.map((d) => dayName(d, 'short'))
    );
  }
  if (v.weekday) out.weekday = dayName(v.weekday, 'long');
  if (v.nth !== undefined) out.nth = v.nth;
  if (v.monthDay !== undefined) out.day = v.monthDay;
  if (v.month !== undefined && v.monthDay !== undefined) {
    out.date = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
    }).format(new Date(Date.UTC(2000, v.month - 1, v.monthDay)));
  }
  if (v.until) {
    out.until = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(keyDate(v.until));
  }
  if (v.count !== undefined) out.count = v.count;
  return out;
}
