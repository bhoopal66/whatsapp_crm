/**
 * The recruiter chat's Interview field (migration 339). A native
 * `datetime-local` input holds a wall-clock time with no zone, and the
 * browser's own zone is not HR's: the field is always Dubai time, the
 * clock the reminder's {slot} is written in (`automsg/slot.ts`). These
 * convert between that input value and the ISO instant `hrSetInterview`
 * stores, and decide what the field refuses before it writes (the RPC
 * refuses a time that is not in the future again).
 */
import { SLOT_TIME_ZONE } from './automsg/slot';

/** The clock the Interview field shows and reads. */
export const INTERVIEW_TIME_ZONE = SLOT_TIME_ZONE;

/** A `datetime-local` value to the minute: `YYYY-MM-DDTHH:mm`. */
const INPUT_VALUE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: INTERVIEW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wallClock(at: Date): string {
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(at)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function parse(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A stored interview time as the input's value, in Dubai time; '' for none. */
export function toInterviewInput(iso: string | null | undefined): string {
  const at = parse(iso);
  return at ? wallClock(at) : '';
}

/**
 * The input's value (Dubai wall clock) as a UTC ISO instant; null when it
 * is not a whole, real date and time (a half-typed or impossible value).
 */
export function fromInterviewInput(value: string): string | null {
  const m = INPUT_VALUE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // The zone's offset at that moment: read the wall clock back and take
  // the difference (exact for a fixed-offset zone such as Dubai).
  const offset = Date.parse(`${wallClock(new Date(asUtc))}:00Z`) - asUtc;
  const at = new Date(asUtc - offset);
  // A round trip that changes the value means it never existed
  // (31 April, hour 24): Date.UTC would have rolled it over.
  return wallClock(at) === value ? at.toISOString() : null;
}

/** The earliest value the input offers: now, in Dubai time. */
export function interviewInputMin(now: Date): string {
  return wallClock(now);
}

/** Why the field will not save `value`; null when it may. */
export type InterviewDraftError = 'invalid' | 'past';

export function interviewDraftError(
  value: string,
  now: Date
): InterviewDraftError | null {
  const iso = fromInterviewInput(value);
  if (!iso) return 'invalid';
  return new Date(iso).getTime() > now.getTime() ? null : 'past';
}

/** A stored interview time for display, in Dubai time, in `locale`. */
export function formatInterviewTime(
  iso: string | null | undefined,
  locale: string
): string | null {
  const at = parse(iso);
  if (!at) return null;
  return new Intl.DateTimeFormat(locale, {
    timeZone: INTERVIEW_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}
