// ============================================================
// When a `time_based` automation is due, and for which chats.
//
// A time-based automation is a schedule (`trigger_config.schedule`, a
// 5-field cron read in `timezone`, default AUTOMATION_TIME_ZONE) plus
// an audience: the chats that sit at a chat tag (`chat_tag_id`, and
// `chat_sub_tag_id` when set) when the schedule comes round. Each
// occurrence runs the automation once for each such chat; migration
// 324's claim row (automation, chat, occurrence) is what makes it once.
//
// Pure: the automations cron (`time-based-run.ts`) does the reading.
// ============================================================

import { consentRefusal } from '@/lib/whatsapp/send-origin';
import { parseClock } from '@/lib/time-of-day';

import { AUTOMATION_TIME_ZONE } from './schedule';

/**
 * How long an occurrence stays due. The cron is pinged about once a
 * minute; a chat not reached in this time (a missed ping, more chats
 * than one pass takes) is not caught up later, so a stopped cron never
 * sends a backlog when it starts again.
 */
export const TIME_BASED_GRACE_MS = 60 * 60_000;

interface CronField {
  any: boolean;
  values: ReadonlySet<number>;
}

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  /** 0 = Sunday; a stored 7 is read as 0. */
  dayOfWeek: CronField;
}

const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(raw: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  let any = false;
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] === '*') {
      if (m[2] === undefined) any = true;
    } else {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      // "5/15" means from 5 to the end, as in standard cron.
      hi = b ?? (m[2] === undefined ? a : max);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any, values };
}

/**
 * Reads a stored schedule: a 5-field cron (numbers, `*`, ranges, lists
 * and steps; no names) or a legacy "HH:mm", meaning every day at that
 * time. Null when it is neither.
 */
export function parseCron(
  schedule: string | null | undefined
): CronSpec | null {
  const v = (schedule ?? '').trim();
  const clock = parseClock(v);
  if (clock && !/\s/.test(v)) {
    return parseCron(`${clock.minute} ${clock.hour} * * *`);
  }
  const parts = v.split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const f = parseField(parts[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!f) return null;
    fields.push(f);
  }
  const dow = fields[4];
  if (dow.values.has(7)) {
    const values = new Set(dow.values);
    values.delete(7);
    values.add(0);
    fields[4] = { any: dow.any, values };
  }
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(at)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday] ?? -1,
  };
}

function matches(spec: CronSpec, at: Date, tz: string): boolean {
  const w = wallClock(at, tz);
  if (!spec.minute.values.has(w.minute)) return false;
  if (!spec.hour.values.has(w.hour)) return false;
  if (!spec.month.values.has(w.month)) return false;
  const dom = spec.dayOfMonth.values.has(w.day);
  const dow = spec.dayOfWeek.values.has(w.weekday);
  // Standard cron: with both day fields restricted, either one matches.
  if (!spec.dayOfMonth.any && !spec.dayOfWeek.any) return dom || dow;
  return dom && dow;
}

function validZone(tz: string | null | undefined): string {
  if (!tz) return AUTOMATION_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return AUTOMATION_TIME_ZONE;
  }
}

/**
 * The latest minute at or before `now` the schedule names, if it is
 * less than `TIME_BASED_GRACE_MS` old; null otherwise.
 */
export function latestOccurrence(
  schedule: string | null | undefined,
  now: Date,
  timezone?: string | null
): Date | null {
  const spec = parseCron(schedule);
  if (!spec) return null;
  const tz = validZone(timezone);
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let t = start; now.getTime() - t < TIME_BASED_GRACE_MS; t -= 60_000) {
    const at = new Date(t);
    if (matches(spec, at, tz)) return at;
  }
  return null;
}

export interface TimeBasedConfig {
  schedule?: unknown;
  timezone?: unknown;
  chat_tag_id?: unknown;
  chat_sub_tag_id?: unknown;
}

/**
 * The occurrence (ISO) a time-based automation is due for at `now`, or
 * null: no chat tag, a schedule that cannot be read, nothing in the
 * last hour, or an occurrence from before the automation existed.
 */
export function dueOccurrence(
  config: TimeBasedConfig | null | undefined,
  createdAt: string | null | undefined,
  now: Date
): string | null {
  if (typeof config?.chat_tag_id !== 'string' || !config.chat_tag_id)
    return null;
  if (typeof config.schedule !== 'string') return null;
  const tz = typeof config.timezone === 'string' ? config.timezone : null;
  const occ = latestOccurrence(config.schedule, now, tz);
  if (!occ) return null;
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isFinite(created) && occ.getTime() < created) return null;
  return occ.toISOString();
}

export interface TimeBasedCandidate {
  id: string;
  contact_id: string | null;
  contact?: {
    opted_out_at?: string | null;
    do_not_contact_at?: string | null;
  } | null;
}

export interface TimeBasedSubject {
  conversationId: string;
  contactId: string;
}

/**
 * The chats to start this pass, at most `limit`: not yet claimed for
 * this occurrence, with a contact, who has not opted out and is not
 * marked do not contact (a schedule is never an answer to the customer,
 * so an opted-out customer gets no run at all; the engine's own consent
 * check stays behind it).
 */
export function timeBasedSubjects(
  candidates: readonly TimeBasedCandidate[],
  claimed: ReadonlySet<string>,
  limit: number
): TimeBasedSubject[] {
  const out: TimeBasedSubject[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (!c.contact_id || claimed.has(c.id)) continue;
    if (!c.contact || consentRefusal(c.contact)) continue;
    out.push({ conversationId: c.id, contactId: c.contact_id });
  }
  return out;
}
