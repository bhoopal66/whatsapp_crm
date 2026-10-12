/** Time helpers. All instants are ISO strings; window math in UTC; local time by fixed offset (Dubai: +240, no DST). */
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
const DAY = UNIT_MS.d;

export const toMs = (iso: string): number => Date.parse(iso);
export const toIso = (ms: number): string => new Date(ms).toISOString();
export const addMs = (iso: string, ms: number): string => toIso(toMs(iso) + ms);

export function parseDuration(s: string): number {
  const m = /^(\d+)([dhm])$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}"`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** null when `now` is inside [start, end) local time; otherwise the next local `start` as an ISO instant. */
export function quietHoursNotBefore(
  now: string,
  q: { utcOffsetMinutes: number; start: string; end: string }
): string | null {
  const offset = q.utcOffsetMinutes * 60_000;
  const local = toMs(now) + offset;
  const dayStart = Math.floor(local / DAY) * DAY;
  const minute = (local - dayStart) / 60_000;
  const start = minutesOf(q.start),
    end = minutesOf(q.end);
  if (minute >= start && minute < end) return null;
  return toIso(dayStart + start * 60_000 + (minute >= end ? DAY : 0) - offset);
}
