/**
 * Pure pieces of the Settings → Team chat "Export a channel" card: the
 * picked days as exportChannel bounds, and the picker's channel list.
 */
import type { ChannelKind } from './types';

type Ymd = [number, number, number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(s: string | undefined): Ymd | null {
  const m = s ? DAY.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y &&
    check.getUTCMonth() === mo - 1 &&
    check.getUTCDate() === d
    ? [y, mo, d]
    : null;
}

/** The zone's offset from UTC (ms) at an instant. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour'),
    g('minute'),
    g('second')
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant the zone's wall clock reads 00:00 on that day. */
function localMidnight([y, mo, d]: Ymd, timeZone: string): number {
  const wall = Date.UTC(y, mo - 1, d);
  // Two passes settle the offset when a DST change falls near midnight.
  let guess = wall - offsetAt(wall, timeZone);
  guess = wall - offsetAt(guess, timeZone);
  return guess;
}

/**
 * The picked days as ISO bounds in the viewer's time zone. `from` is
 * that day's local midnight; `to` is the next local midnight minus 1 ms,
 * so the whole picked day is in (the database's `created_at <= to` is
 * inclusive). A message in the final sub-millisecond of the day is
 * accepted as missed: timestamps carry microseconds, the bound only ms.
 * An empty or malformed day leaves that side open.
 */
export function exportBounds(i: {
  fromDay?: string;
  toDay?: string;
  timeZone: string;
}): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  const f = parseDay(i.fromDay);
  const t = parseDay(i.toDay);
  if (f) out.from = new Date(localMidnight(f, i.timeZone)).toISOString();
  if (t) {
    const next = new Date(Date.UTC(t[0], t[1] - 1, t[2] + 1));
    const nextDay: Ymd = [
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
    ];
    out.to = new Date(localMidnight(nextDay, i.timeZone) - 1).toISOString();
  }
  return out;
}

/** 'order' when From is after To (the database refuses it too). */
export function exportRangeError(
  fromDay?: string,
  toDay?: string
): 'order' | null {
  const f = parseDay(fromDay);
  const t = parseDay(toDay);
  if (!f || !t) return null;
  const key = ([y, m, d]: Ymd) => y * 10000 + m * 100 + d;
  return key(f) > key(t) ? 'order' : null;
}

export interface ExportChannelOption {
  id: string;
  kind: ChannelKind;
  name: string | null;
  /** A DM without a name: who is in it. */
  memberNames: string[];
}

/** Merge the caller's channels with the admin-only list; first one wins. */
export function mergeExportChannels(
  ...lists: ExportChannelOption[][]
): ExportChannelOption[] {
  const seen = new Map<string, ExportChannelOption>();
  for (const list of lists)
    for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
  const label = (c: ExportChannelOption) => c.name ?? c.memberNames.join(', ');
  return [...seen.values()].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.id.localeCompare(b.id)
  );
}
