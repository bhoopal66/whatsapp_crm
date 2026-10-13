// The Calls screen's "By person" report (module 015, migration 098):
// the period in the account's time zone, the rows pbx_call_report
// returns, and the figures the tab shows. Pure, and safe for the
// browser: the tab imports it, so nothing here pulls in next/server
// (./calls does).

import { isValidTimeZone } from '@/lib/team-activity/limits';
import { zoneOffsetMs, zonedDayStart } from '@/lib/team-activity/range';

export const CALL_REPORT_PERIODS = [
  'today',
  'week',
  'month',
  'custom',
] as const;
export type CallReportPeriod = (typeof CALL_REPORT_PERIODS)[number];

export function isCallReportPeriod(value: unknown): value is CallReportPeriod {
  return (
    typeof value === 'string' &&
    (CALL_REPORT_PERIODS as readonly string[]).includes(value)
  );
}

/** A custom period's longest span in days; 098 refuses over 100. */
export const CALL_REPORT_MAX_DAYS = 92;

/** The workspace's zone when neither the account nor the viewer names one. */
const FALLBACK_ZONE = 'Asia/Dubai';

/**
 * The account's zone (the one an admin saved for Team activity, 068),
 * else the viewer's, else the UAE's: as the Team activity page, so
 * "today" is the same day on both.
 */
export function reportTimeZone(
  saved: unknown,
  viewer: string | null | undefined
): string {
  if (typeof saved === 'string' && saved && isValidTimeZone(saved))
    return saved;
  if (viewer && isValidTimeZone(viewer)) return viewer;
  return FALLBACK_ZONE;
}

/** The calendar date (y, m 1-12, d) at `instant` in `timeZone`. */
function localDate(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The instant local midnight begins y-m-d in `timeZone` (DST-safe). */
export function zonedMidnight(
  y: number,
  m: number,
  d: number,
  timeZone: string
): Date {
  const local = Date.UTC(y, m - 1, d);
  const guess = local - zoneOffsetMs(local, timeZone);
  return new Date(local - zoneOffsetMs(guess, timeZone));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value: string | null | undefined) {
  const m = DAY_RE.exec(value ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-30 rolls over: refuse it rather than move it.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1) return null;
  return { y, m: mo, d, day: at.getTime() / 86_400_000 };
}

export type CustomDaysProblem = 'missing' | 'order' | 'span';

/** Why two YYYY-MM-DD days (both inclusive) are not a period, or null. */
export function checkCustomDays(
  from: string | null | undefined,
  to: string | null | undefined
): CustomDaysProblem | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return 'missing';
  if (b.day < a.day) return 'order';
  if (b.day - a.day + 1 > CALL_REPORT_MAX_DAYS) return 'span';
  return null;
}

export type CallReportRange =
  | { ok: true; from: Date; to: Date }
  | { ok: false; problem: CustomDaysProblem };

/**
 * [from, to) of a period in `timeZone`: today, this week (from Monday,
 * the UAE's first working day), this month — each up to `now` — or
 * whole custom days, both inclusive.
 */
export function callReportRange(
  period: CallReportPeriod,
  now: Date,
  timeZone: string,
  custom?: { from?: string | null; to?: string | null }
): CallReportRange {
  if (period === 'custom') {
    const problem = checkCustomDays(custom?.from, custom?.to);
    if (problem) return { ok: false, problem };
    const a = parseDay(custom?.from)!;
    const b = parseDay(custom?.to)!;
    return {
      ok: true,
      from: zonedMidnight(a.y, a.m, a.d, timeZone),
      to: zonedMidnight(b.y, b.m, b.d + 1, timeZone),
    };
  }
  const { y, m, d } = localDate(now, timeZone);
  const back =
    period === 'today'
      ? 0
      : period === 'week'
        ? (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
        : d - 1;
  const from = zonedDayStart(now, timeZone, back);
  // A request on the very millisecond of midnight.
  const to =
    now.getTime() > from.getTime() ? now : new Date(from.getTime() + 1000);
  return { ok: true, from, to };
}

// ---------- The rows ----------

/** The calls.disposition values, then answered calls with none. */
export const CALL_REPORT_OUTCOMES = [
  'interested',
  'docs_requested',
  'call_back',
  'not_eligible',
  'wrong_number',
  'none',
] as const;
export type CallReportOutcome = (typeof CALL_REPORT_OUTCOMES)[number];

export interface CallReportFigures {
  inboundAnswered: number;
  outbound: number;
  missed: number;
  /** Talk time of the answered calls, and how many carry one. */
  talkSeconds: number;
  talkCalls: number;
  /** Ring time of the answered incoming calls, and how many carry one. */
  ringSeconds: number;
  ringCalls: number;
  outcomes: Record<CallReportOutcome, number>;
}

export interface CallReportPerson extends CallReportFigures {
  userId: string;
  name: string | null;
  extension: string | null;
}

export interface CallReport {
  people: CallReportPerson[];
  /** Calls with no person: a ring group nobody answered, an unmapped extension. */
  unattributed: CallReportFigures;
  /** Every call in the workspace in the period. */
  total: CallReportFigures;
}

const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

function figures(row: Record<string, unknown> | undefined): CallReportFigures {
  const raw =
    row?.outcomes && typeof row.outcomes === 'object'
      ? (row.outcomes as Record<string, unknown>)
      : {};
  return {
    inboundAnswered: count(row?.inbound_answered),
    outbound: count(row?.outbound),
    missed: count(row?.missed),
    talkSeconds: count(row?.talk_seconds),
    talkCalls: count(row?.talk_calls),
    ringSeconds: count(row?.ring_seconds),
    ringCalls: count(row?.ring_calls),
    outcomes: Object.fromEntries(
      CALL_REPORT_OUTCOMES.map((k) => [k, count(raw[k])])
    ) as Record<CallReportOutcome, number>,
  };
}

/** pbx_call_report's rows, read defensively; people keep the SQL's order. */
export function parseCallReport(rows: unknown): CallReport {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object'
  );
  const people: CallReportPerson[] = [];
  for (const r of list) {
    if (r.row_kind !== 'person' || typeof r.user_id !== 'string') continue;
    people.push({
      userId: r.user_id,
      name: text(r.full_name),
      extension: text(r.extension),
      ...figures(r),
    });
  }
  return {
    people,
    unattributed: figures(list.find((r) => r.row_kind === 'none')),
    total: figures(list.find((r) => r.row_kind === 'total')),
  };
}

// ---------- What the tab shows ----------

/** Whole seconds per call, or null with nothing to average. */
export function averageSeconds(total: number, calls: number): number | null {
  return calls > 0 ? Math.round(total / calls) : null;
}

/** "0:42", "12:05", "1:02:09"; an em dash for no figure. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The outcomes worth showing: non-zero, in a fixed order. */
export function outcomeCounts(
  f: CallReportFigures
): { outcome: CallReportOutcome; count: number }[] {
  return CALL_REPORT_OUTCOMES.filter((k) => f.outcomes[k] > 0).map((k) => ({
    outcome: k,
    count: f.outcomes[k],
  }));
}

/** Any call counted at all (an outcome alone counts too). */
export function hasCalls(f: CallReportFigures): boolean {
  return (
    f.inboundAnswered + f.outbound + f.missed > 0 ||
    CALL_REPORT_OUTCOMES.some((k) => f.outcomes[k] > 0)
  );
}
