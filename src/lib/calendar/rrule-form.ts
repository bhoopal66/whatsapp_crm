// ============================================================
// Repeat picker <-> RRULE body (migration 108) — pure, no I/O.
//
// The picker offers what a person means by "repeat": daily, weekly on
// some days, monthly on a date or on the nth/last weekday, yearly, with
// an interval and an end. Day, weekday and month come from the event's
// first date (the anchor), as in most calendars, so a rule naming a
// different day is not representable here and reads back as custom
// (null). UNTIL is written as the end of the chosen day in the event's
// zone, as a UTC instant (…Z), which recurrence.ts reads back exactly.
// ============================================================

import { fromFloating, toFloating, wallClock } from './recurrence';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type RepeatFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
/** Monthly on the anchor's date, its nth weekday, or its last weekday. */
export type MonthlyMode = 'date' | 'nth' | 'last';
export type RepeatEnds = 'never' | 'on' | 'after';

export const INTERVAL_MAX = 99;
export const COUNT_MAX = 999;

export interface RepeatForm {
  freq: RepeatFreq;
  interval: number;
  /** Weekly only; empty means the anchor's weekday. */
  weekdays: Weekday[];
  monthly: MonthlyMode;
  ends: RepeatEnds;
  /** YYYY-MM-DD, last day the series may occur on (ends = 'on'). */
  until: string | null;
  /** Number of occurrences (ends = 'after'). */
  count: number | null;
}

/** The first occurrence's date in the event's zone, and that zone. */
export interface RepeatAnchor {
  date: string;
  timeZone: string;
}

export interface AnchorFacts {
  weekday: Weekday;
  monthDay: number;
  month: number;
  /** 1..5: which occurrence of its weekday in the month. */
  nth: number;
  /** The anchor is its weekday's last in the month. */
  isLast: boolean;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function ymd(date: string): [number, number, number] {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  return [+m[1], +m[2], +m[3]];
}

export function anchorFacts(anchor: RepeatAnchor): AnchorFacts {
  const [y, mo, d] = ymd(anchor.date);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return {
    weekday: WEEKDAYS[(dow + 6) % 7],
    monthDay: d,
    month: mo,
    nth: Math.ceil(d / 7),
    isLast: d + 7 > daysInMonth,
  };
}

export function defaultRepeatForm(anchor: RepeatAnchor): RepeatForm {
  return {
    freq: 'none',
    interval: 1,
    weekdays: [anchorFacts(anchor).weekday],
    monthly: 'date',
    ends: 'never',
    until: null,
    count: null,
  };
}

const sortDays = (days: Iterable<Weekday>) =>
  [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** End of the day in the zone as an RRULE UTC stamp (YYYYMMDDTHHMMSSZ). */
function untilStamp(date: string, timeZone: string): string {
  const [y, mo, d] = ymd(date);
  const t = new Date(
    fromFloating(Date.UTC(y, mo - 1, d, 23, 59, 59), timeZone)
  );
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`
  );
}

/** The day an UNTIL value falls on in the zone, as YYYY-MM-DD. */
function untilDate(value: string, timeZone: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value
  );
  if (!m) return null;
  if (!m[7]) return `${m[1]}-${m[2]}-${m[3]}`;
  const w = wallClock(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
    timeZone
  );
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/**
 * The RRULE body for a picker state, or null for "does not repeat".
 * Throws RangeError for a state the picker should not allow.
 */
export function formToRrule(
  form: RepeatForm,
  anchor: RepeatAnchor
): string | null {
  if (form.freq === 'none') return null;
  const facts = anchorFacts(anchor);
  const parts = [`FREQ=${form.freq.toUpperCase()}`];
  if (
    !Number.isInteger(form.interval) ||
    form.interval < 1 ||
    form.interval > INTERVAL_MAX
  ) {
    throw new RangeError(`Interval must be 1 to ${INTERVAL_MAX}`);
  }
  if (form.interval > 1) parts.push(`INTERVAL=${form.interval}`);
  if (form.freq === 'weekly') {
    const days = sortDays(
      form.weekdays.length ? form.weekdays : [facts.weekday]
    );
    parts.push(`BYDAY=${days.join(',')}`);
  } else if (form.freq === 'monthly') {
    if (form.monthly === 'date') parts.push(`BYMONTHDAY=${facts.monthDay}`);
    else if (form.monthly === 'nth')
      parts.push(`BYDAY=${facts.nth}${facts.weekday}`);
    else {
      if (!facts.isLast) {
        throw new RangeError('The start date is not the last of its weekday');
      }
      parts.push(`BYDAY=-1${facts.weekday}`);
    }
  }
  if (form.ends === 'on') {
    if (!form.until || form.until < anchor.date) {
      throw new RangeError('The repeat must end on or after the first date');
    }
    parts.push(`UNTIL=${untilStamp(form.until, anchor.timeZone)}`);
  } else if (form.ends === 'after') {
    const n = form.count;
    if (!Number.isInteger(n) || n! < 1 || n! > COUNT_MAX) {
      throw new RangeError(`Occurrences must be 1 to ${COUNT_MAX}`);
    }
    parts.push(`COUNT=${n}`);
  }
  return parts.join(';');
}

/**
 * The picker state for a stored RRULE body (null body = "does not
 * repeat"), or null when the rule is not one the picker can show.
 */
export function rruleToForm(
  body: string | null,
  anchor: RepeatAnchor
): RepeatForm | null {
  const form = defaultRepeatForm(anchor);
  if (!body) return form;
  const facts = anchorFacts(anchor);
  const parts = new Map<string, string>();
  for (const p of body.split(';')) {
    const [k, v, extra] = p.split('=');
    if (!k || !v || extra !== undefined || parts.has(k)) return null;
    parts.set(k, v);
  }
  const take = (k: string) => {
    const v = parts.get(k);
    parts.delete(k);
    return v;
  };
  const freq = take('FREQ')?.toLowerCase();
  if (
    freq !== 'daily' &&
    freq !== 'weekly' &&
    freq !== 'monthly' &&
    freq !== 'yearly'
  ) {
    return null;
  }
  form.freq = freq;

  const interval = take('INTERVAL');
  if (interval !== undefined) {
    if (!/^\d+$/.test(interval) || +interval < 1 || +interval > INTERVAL_MAX) {
      return null;
    }
    form.interval = +interval;
  }
  const count = take('COUNT');
  const until = take('UNTIL');
  if (count !== undefined && until !== undefined) return null;
  if (count !== undefined) {
    if (!/^\d+$/.test(count) || +count < 1 || +count > COUNT_MAX) return null;
    form.ends = 'after';
    form.count = +count;
  } else if (until !== undefined) {
    const date = untilDate(until, anchor.timeZone);
    if (!date) return null;
    form.ends = 'on';
    form.until = date;
  }

  const byDay = take('BYDAY');
  const byMonthDay = take('BYMONTHDAY');
  const byMonth = take('BYMONTH');
  if (freq === 'weekly') {
    if (byMonthDay !== undefined || byMonth !== undefined) return null;
    if (byDay !== undefined) {
      const days = byDay.split(',');
      if (!days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) {
        return null;
      }
      form.weekdays = sortDays(days as Weekday[]);
    }
  } else if (freq === 'monthly') {
    if (byMonth !== undefined) return null;
    if (byDay !== undefined && byMonthDay !== undefined) return null;
    if (byMonthDay !== undefined && +byMonthDay !== facts.monthDay) return null;
    if (byDay !== undefined) {
      const m = /^(-1|[1-5])([A-Z]{2})$/.exec(byDay);
      if (!m || m[2] !== facts.weekday) return null;
      if (m[1] === '-1' && facts.isLast) form.monthly = 'last';
      else if (+m[1] === facts.nth) form.monthly = 'nth';
      else return null;
    }
  } else if (freq === 'yearly') {
    if (byDay !== undefined) return null;
    if ((byMonth === undefined) !== (byMonthDay === undefined)) return null;
    if (
      byMonth !== undefined &&
      (+byMonth !== facts.month || +byMonthDay! !== facts.monthDay)
    ) {
      return null;
    }
  } else if (
    byDay !== undefined ||
    byMonthDay !== undefined ||
    byMonth !== undefined
  ) {
    return null;
  }
  return parts.size ? null : form;
}

export type RepeatKey =
  | 'daily'
  | 'weekly'
  | 'monthlyDate'
  | 'monthlyNth'
  | 'monthlyLast'
  | 'yearly'
  | 'custom';

/** What the UI translates: a message key and its values. */
export interface RepeatDescription {
  key: RepeatKey;
  values: {
    interval?: number;
    weekdays?: Weekday[];
    monthDay?: number;
    month?: number;
    nth?: number;
    weekday?: Weekday;
    ends?: RepeatEnds;
    until?: string;
    count?: number;
  };
}

/** A short description model of a rule, or null when it does not repeat. */
export function describeRrule(
  body: string | null,
  anchor: RepeatAnchor
): RepeatDescription | null {
  if (!body) return null;
  const form = rruleToForm(body, anchor);
  if (!form || form.freq === 'none') return { key: 'custom', values: {} };
  const facts = anchorFacts(anchor);
  const values: RepeatDescription['values'] = {
    interval: form.interval,
    ends: form.ends,
  };
  if (form.ends === 'on') values.until = form.until!;
  if (form.ends === 'after') values.count = form.count!;
  let key: RepeatKey;
  switch (form.freq) {
    case 'daily':
      key = 'daily';
      break;
    case 'weekly':
      key = 'weekly';
      values.weekdays = form.weekdays;
      break;
    case 'monthly':
      if (form.monthly === 'date') {
        key = 'monthlyDate';
        values.monthDay = facts.monthDay;
      } else {
        key = form.monthly === 'nth' ? 'monthlyNth' : 'monthlyLast';
        values.weekday = facts.weekday;
        if (form.monthly === 'nth') values.nth = facts.nth;
      }
      break;
    case 'yearly':
      key = 'yearly';
      values.month = facts.month;
      values.monthDay = facts.monthDay;
      break;
  }
  return { key, values };
}

const DAY_MS = 86_400_000;
const BYDAY_VALUE = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;

/** An UNTIL value moved by whole days (a …Z instant on the zone's wall
 *  clock, so a DST change between keeps its local time). */
function shiftUntil(value: string, days: number, timeZone: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value
  );
  if (!m) return value;
  const [, y, mo, d, h, mi, sec, z] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(sec ?? 0));
  if (z) ms = fromFloating(toFloating(ms, timeZone) + days * DAY_MS, timeZone);
  else ms += days * DAY_MS;
  const t = new Date(ms);
  const date = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
  if (h === undefined) return date;
  return `${date}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}${z ?? ''}`;
}

/**
 * The rule that keeps a series on the same days after its first date
 * (the anchor, in the event's zone) moves by `dayDelta` whole days, or
 * null when no rule says that exactly enough to save without asking.
 *
 * - BYDAY weekdays move by the delta. A weekly rule with INTERVAL > 1
 *   refuses when the days would split across a week boundary (WKST),
 *   and a monthly plain-weekday rule needs INTERVAL=1.
 * - A monthly nth / last weekday (2TU, -1FR) keeps its ordinal and moves
 *   its weekday while the anchor stays inside that ordinal's 7-day block
 *   of its month; crossing it would change the ordinal: refused.
 * - BYMONTHDAY moves by the delta while old and new days are both ones
 *   every month has (1..28, or -1..-28), so no month gains or loses an
 *   occurrence.
 * - UNTIL moves with the series so it keeps its last occurrence.
 * - BYMONTH, BYSETPOS, BYDAY with BYMONTHDAY, and yearly BY* rules are
 *   refused.
 */
export function shiftRule(
  rrule: string,
  dayDelta: number,
  anchor: RepeatAnchor
): string | null {
  if (dayDelta === 0) return rrule;
  const parts = rrule.split(';').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)] as [string, string];
  });
  const get = (k: string) => parts.find(([key]) => key === k)?.[1];
  const freq = get('FREQ');
  const interval = Number(get('INTERVAL') ?? 1);
  const byday = get('BYDAY');
  const bymonthday = get('BYMONTHDAY');
  if (get('BYMONTH') !== undefined || get('BYSETPOS') !== undefined) {
    return null;
  }
  if (byday !== undefined && bymonthday !== undefined) return null;
  if (freq === 'YEARLY' && (byday ?? bymonthday) !== undefined) return null;
  const shiftDay = (wd: Weekday) =>
    WEEKDAYS[(((WEEKDAYS.indexOf(wd) + dayDelta) % 7) + 7) % 7];

  const moveByday = (value: string): string | null => {
    const days = value.split(',').map((v) => BYDAY_VALUE.exec(v));
    if (days.some((d) => !d)) return null;
    const parsed = days.map((d) => ({
      n: d![1] ? Number(d![1]) : null,
      wd: d![2] as Weekday,
    }));
    if (parsed.some((d) => d.n !== null)) {
      if (freq !== 'MONTHLY' || parsed.length !== 1) return null;
      const { n, wd } = parsed[0];
      const [y, mo, d] = ymd(anchor.date);
      const len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      if (n === 0 || anchorFacts(anchor).weekday !== wd) return null;
      const first = n! > 0 ? 7 * (n! - 1) + 1 : len + 7 * n! + 1;
      const moved = d + dayDelta;
      if (moved < Math.max(1, first) || moved > Math.min(len, first + 6)) {
        return null;
      }
      return `${n}${shiftDay(wd)}`;
    }
    if (freq === 'MONTHLY' && interval !== 1) return null;
    if (freq === 'WEEKLY' && interval !== 1) {
      const wkst = WEEKDAYS.indexOf((get('WKST') ?? 'MO') as Weekday);
      const weeks = new Set(
        parsed.map((p) =>
          Math.floor((((WEEKDAYS.indexOf(p.wd) - wkst + 7) % 7) + dayDelta) / 7)
        )
      );
      if (weeks.size !== 1) return null;
    }
    return sortDays(parsed.map((p) => shiftDay(p.wd))).join(',');
  };

  const moveMonthday = (value: string): string | null => {
    if (freq !== 'MONTHLY' && freq !== 'DAILY') return null;
    const out: number[] = [];
    for (const v of value.split(',')) {
      const n = Number(v);
      const m = n + dayDelta;
      const ok =
        n > 0 ? n <= 28 && m >= 1 && m <= 28 : n >= -28 && m <= -1 && m >= -28;
      if (!Number.isInteger(n) || n === 0 || !ok) return null;
      out.push(m);
    }
    return out.join(',');
  };

  const out: string[] = [];
  for (const [key, value] of parts) {
    let next: string | null = value;
    if (key === 'BYDAY') next = moveByday(value);
    else if (key === 'BYMONTHDAY') next = moveMonthday(value);
    else if (key === 'UNTIL')
      next = shiftUntil(value, dayDelta, anchor.timeZone);
    if (next === null) return null;
    out.push(`${key}=${next}`);
  }
  return out.join(';');
}
