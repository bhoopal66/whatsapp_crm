import type { FeedItem } from '../feed';
import { wallDateKey } from '../fc-timezone';
import { parseDateKey } from './url-state';

export interface MiniDay {
  key: string;
  day: number;
  inMonth: boolean;
}

const DAY_MS = 86_400_000;
/** Longest span marked per item, so a runaway range cannot loop. */
const MAX_MARKED_DAYS = 62;

function keyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function keyMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

export function addDaysToKey(key: string, days: number): string {
  return keyOf(keyMs(key) + days * DAY_MS);
}

export function addMonths(
  year: number,
  month0: number,
  delta: number
): { year: number; month0: number } {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

/** Six weeks starting on `firstDay` (0 Sunday … 6 Saturday). */
export function monthGrid(
  year: number,
  month0: number,
  firstDay = 1
): MiniDay[][] {
  const firstMs = Date.UTC(year, month0, 1);
  const lead = (new Date(firstMs).getUTCDay() - firstDay + 7) % 7;
  const startMs = firstMs - lead * DAY_MS;
  const weeks: MiniDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: MiniDay[] = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(startMs + (w * 7 + d) * DAY_MS);
      week.push({
        key: keyOf(dt.getTime()),
        day: dt.getUTCDate(),
        inMonth: dt.getUTCMonth() === month0,
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Every day (in `zone`) that some item touches. */
export function markedDays(
  items: readonly FeedItem[],
  zone: string
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    let first: string | null;
    let last: string | null;
    if (item.allDay) {
      first = parseDateKey(item.start);
      const endExclusive = parseDateKey(item.end);
      last = endExclusive ? addDaysToKey(endExclusive, -1) : first;
    } else {
      const s = Date.parse(item.start);
      const e = Date.parse(item.end);
      if (!Number.isFinite(s)) continue;
      first = wallDateKey(zone, s);
      last = Number.isFinite(e) && e > s ? wallDateKey(zone, e - 1) : first;
    }
    if (!first) continue;
    if (!last || last < first) last = first;
    let key = first;
    for (let i = 0; i < MAX_MARKED_DAYS && key <= last; i++) {
      out.add(key);
      key = addDaysToKey(key, 1);
    }
  }
  return out;
}
