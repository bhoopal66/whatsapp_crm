import { createPlugin } from '@fullcalendar/core';
import { NamedTimeZoneImpl } from '@fullcalendar/core/internal';

/**
 * Named time zones for FullCalendar without luxon or moment-timezone.
 *
 * FullCalendar on its own understands only 'local' and 'UTC'; anything
 * else needs a plugin that answers two questions about the zone. Both
 * are answered here with `Intl.DateTimeFormat`, which every supported
 * browser (and Node) ships with the IANA database.
 *
 * Arrays are FullCalendar's: [year, month (0-based), day, hour, minute,
 * second, ms]. Offsets are minutes east of UTC (Dubai = +240).
 */

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Whether the runtime knows this IANA zone. */
export function isValidTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's wall clock at the instant `ms`, as a FullCalendar array. */
export function timestampToWallArray(zone: string, ms: number): number[] {
  const parts = formatterFor(zone).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  let year = get('year');
  // Years before 1 CE come back as a positive year with era "BC".
  if (parts.find((p) => p.type === 'era')?.value === 'BC') year = 1 - year;
  const hour = get('hour') % 24;
  const msPart = ((ms % 1000) + 1000) % 1000;
  return [
    year,
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
    msPart,
  ];
}

function arrayToUtcMs(a: readonly number[]): number {
  const d = new Date(0);
  d.setUTCFullYear(a[0] ?? 1970, a[1] ?? 0, a[2] ?? 1);
  d.setUTCHours(a[3] ?? 0, a[4] ?? 0, a[5] ?? 0, a[6] ?? 0);
  return d.getTime();
}

/** Minutes east of UTC that `zone` observes at the instant `ms`. */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  const wall = arrayToUtcMs(timestampToWallArray(zone, ms));
  return Math.round((wall - ms) / 60_000);
}

/**
 * The offset to read a wall-clock time in `zone` with.
 *
 * - Ordinary times: the one offset that makes the wall time true.
 * - Repeated hour (clocks go back): the earlier of the two instants,
 *   i.e. the larger offset.
 * - Skipped hour (clocks go forward): the offset in force before the
 *   jump, so 02:30 on a spring-forward night reads as 03:30 after it.
 */
export function offsetForWallArray(zone: string, a: readonly number[]): number {
  const wallMs = arrayToUtcMs(a);
  const before = zoneOffsetMinutes(zone, wallMs - DAY_MS);
  const after = zoneOffsetMinutes(zone, wallMs + DAY_MS);
  const candidates = new Set([before, after, zoneOffsetMinutes(zone, wallMs)]);
  const valid = [...candidates].filter(
    (c) => zoneOffsetMinutes(zone, wallMs - c * 60_000) === c
  );
  if (valid.length > 0) return Math.max(...valid);
  return before;
}

/** The UTC instant of a wall-clock time in `zone`. */
export function wallArrayToTimestamp(
  zone: string,
  a: readonly number[]
): number {
  return arrayToUtcMs(a) - offsetForWallArray(zone, a) * 60_000;
}

/** The zone's calendar date at `ms`, as 'YYYY-MM-DD'. */
export function wallDateKey(zone: string, ms: number): string {
  const [y, m, d] = timestampToWallArray(zone, ms);
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export class IntlNamedTimeZone extends NamedTimeZoneImpl {
  offsetForArray(a: number[]): number {
    return offsetForWallArray(this.timeZoneName, a);
  }

  timestampToArray(ms: number): number[] {
    return timestampToWallArray(this.timeZoneName, ms);
  }
}

/** Hand to FullCalendar's `plugins` to make `timeZone="Asia/Dubai"` work. */
export const intlTimeZonePlugin = createPlugin({
  name: 'intl-named-time-zone',
  // FullCalendar's own spelling of the key.
  namedTimeZonedImpl: IntlNamedTimeZone,
});

/** The zone to hand FullCalendar: the given one if valid, else 'local'. */
export function calendarTimeZone(zone: string | null | undefined): string {
  return zone && isValidTimeZone(zone) ? zone : 'local';
}
