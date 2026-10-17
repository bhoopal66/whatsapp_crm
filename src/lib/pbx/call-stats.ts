// The Call report page's figures (module 015, migration 119): what
// pbx_call_stats returns, read defensively into camelCase, and the
// formatters the page shows them with. Pure, and safe for the browser:
// nothing here pulls in next/server.

import {
  CALL_REPORT_OUTCOMES,
  type CallReportOutcome,
} from '@/lib/pbx/call-report';

// ---------- The shape ----------

export interface CallStatsSummary {
  calls: number;
  inboundTotal: number;
  inboundAnswered: number;
  outboundTotal: number;
  outboundAnswered: number;
  missed: number;
  /** inboundAnswered / inboundTotal, 0..1; null with no incoming call. */
  answerRate: number | null;
  talkSecondsTotal: number;
  talkCalls: number;
  avgTalkSeconds: number | null;
  longestTalkSeconds: number | null;
  ringSecondsTotal: number;
  ringCalls: number;
  avgRingSeconds: number | null;
  maxRingSeconds: number | null;
  /** Distinct remote numbers. */
  uniqueNumbers: number;
  /** Calls with an outcome (a disposition). */
  withOutcome: number;
}

/** One local day; the series is zero-filled, oldest first. */
export interface CallStatsDay {
  /** YYYY-MM-DD in the report's zone. */
  day: string;
  calls: number;
  inboundAnswered: number;
  outbound: number;
  outboundAnswered: number;
  missed: number;
  talkSeconds: number;
}

/** A weekday x hour cell; only non-zero cells are sent. */
export interface CallStatsHourCell {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  dow: number;
  /** 0-23. */
  hour: number;
  calls: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

export const TALK_BUCKET_KEYS = [
  'under_30s',
  '30s_2m',
  '2m_5m',
  '5m_15m',
  '15m_plus',
] as const;
export type TalkBucketKey = (typeof TALK_BUCKET_KEYS)[number];

export interface CallStatsTalkBucket {
  key: TalkBucketKey;
  /** Inclusive. */
  minSeconds: number;
  /** Exclusive; null for the last bucket. */
  maxSeconds: number | null;
  calls: number;
}

export type CallStatsOutcomes = Record<CallReportOutcome, number>;

export interface CallStatsPerson extends CallStatsSummary {
  /** 'none': the calls with no person (owners and admins only). */
  kind: 'person' | 'none';
  /** null for the 'none' row. */
  userId: string | null;
  fullName: string | null;
  extension: string | null;
}

export interface CallStatsTopNumber {
  contactId: string | null;
  contactName: string | null;
  /** The latest number the customer called on or was called on. */
  remoteNumber: string | null;
  calls: number;
  talkSeconds: number;
  lastCallAt: string | null;
}

export interface CallStatsLongestCall {
  id: string;
  startedAt: string | null;
  direction: string | null;
  remoteNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  talkSeconds: number;
  userId: string | null;
  userName: string | null;
}

export interface CallStatsRange {
  from: string | null;
  to: string | null;
  tz: string | null;
  previousFrom: string | null;
  previousTo: string | null;
}

export const CALL_STATS_SCOPES = [
  'workspace',
  'team',
  'self',
  'person',
] as const;
export type CallStatsScope = (typeof CALL_STATS_SCOPES)[number];

export interface CallStats {
  summary: CallStatsSummary;
  /** The equally long period just before, for the deltas. */
  previous: CallStatsSummary;
  byDay: CallStatsDay[];
  byHour: CallStatsHourCell[];
  talkBuckets: CallStatsTalkBucket[];
  outcomes: CallStatsOutcomes;
  /** Team leader and up with no person picked; else null. */
  people: CallStatsPerson[] | null;
  /** At most ten. */
  topNumbers: CallStatsTopNumber[];
  /** At most ten. */
  longest: CallStatsLongestCall[];
  range: CallStatsRange;
  scope: CallStatsScope;
  /** The person picked (p_user), else null. */
  userId: string | null;
}

// ---------- Reading it ----------

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** A count: a whole number, 0 for anything missing, negative or bad. */
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && n > 0 ? Math.floor(n) : 0;
};

/** A measure that may be absent (an average, a maximum): null, not 0. */
const measure = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);

function summary(v: unknown): CallStatsSummary {
  const r = isRow(v) ? v : {};
  const rate = num(r.answer_rate);
  return {
    calls: count(r.calls),
    inboundTotal: count(r.inbound_total),
    inboundAnswered: count(r.inbound_answered),
    outboundTotal: count(r.outbound_total),
    outboundAnswered: count(r.outbound_answered),
    missed: count(r.missed),
    answerRate: rate === null ? null : Math.min(1, Math.max(0, rate)),
    talkSecondsTotal: count(r.talk_seconds_total),
    talkCalls: count(r.talk_calls),
    avgTalkSeconds: measure(r.avg_talk_seconds),
    longestTalkSeconds: measure(r.longest_talk_seconds),
    ringSecondsTotal: count(r.ring_seconds_total),
    ringCalls: count(r.ring_calls),
    avgRingSeconds: measure(r.avg_ring_seconds),
    maxRingSeconds: measure(r.max_ring_seconds),
    uniqueNumbers: count(r.unique_numbers),
    withOutcome: count(r.with_outcome),
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function byDay(v: unknown): CallStatsDay[] {
  return rows(v)
    .filter((r) => typeof r.day === 'string' && DAY_RE.test(r.day))
    .map((r) => ({
      day: r.day as string,
      calls: count(r.calls),
      inboundAnswered: count(r.inbound_answered),
      outbound: count(r.outbound),
      outboundAnswered: count(r.outbound_answered),
      missed: count(r.missed),
      talkSeconds: count(r.talk_seconds),
    }));
}

function byHour(v: unknown): CallStatsHourCell[] {
  const out: CallStatsHourCell[] = [];
  for (const r of rows(v)) {
    const dow = num(r.dow);
    const hour = num(r.hour);
    if (dow === null || !Number.isInteger(dow) || dow < 1 || dow > 7) continue;
    if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23)
      continue;
    out.push({
      dow,
      hour,
      calls: count(r.calls),
      answered: count(r.answered),
      missed: count(r.missed),
      talkSeconds: count(r.talk_seconds),
    });
  }
  return out;
}

const isBucketKey = (v: unknown): v is TalkBucketKey =>
  typeof v === 'string' && (TALK_BUCKET_KEYS as readonly string[]).includes(v);

function talkBuckets(v: unknown): CallStatsTalkBucket[] {
  return rows(v)
    .filter((r) => isBucketKey(r.key))
    .map((r) => ({
      key: r.key as TalkBucketKey,
      minSeconds: count(r.min_seconds),
      maxSeconds: measure(r.max_seconds),
      calls: count(r.calls),
    }));
}

function outcomes(v: unknown): CallStatsOutcomes {
  const r = isRow(v) ? v : {};
  return Object.fromEntries(
    CALL_REPORT_OUTCOMES.map((k) => [k, count(r[k])])
  ) as CallStatsOutcomes;
}

function people(v: unknown): CallStatsPerson[] | null {
  if (!Array.isArray(v)) return null;
  const out: CallStatsPerson[] = [];
  for (const r of rows(v)) {
    const userId = text(r.user_id);
    if (r.kind === 'person' && userId) {
      out.push({
        kind: 'person',
        userId,
        fullName: text(r.full_name),
        extension: text(r.extension),
        ...summary(r),
      });
    } else if (r.kind === 'none') {
      out.push({
        kind: 'none',
        userId: null,
        fullName: null,
        extension: null,
        ...summary(r),
      });
    }
  }
  return out;
}

function topNumbers(v: unknown): CallStatsTopNumber[] {
  return rows(v).map((r) => ({
    contactId: text(r.contact_id),
    contactName: text(r.contact_name),
    remoteNumber: text(r.remote_number),
    calls: count(r.calls),
    talkSeconds: count(r.talk_seconds),
    lastCallAt: text(r.last_call_at),
  }));
}

function longest(v: unknown): CallStatsLongestCall[] {
  const out: CallStatsLongestCall[] = [];
  for (const r of rows(v)) {
    const id = text(r.id);
    if (!id) continue;
    out.push({
      id,
      startedAt: text(r.started_at),
      direction: text(r.direction),
      remoteNumber: text(r.remote_number),
      contactId: text(r.contact_id),
      contactName: text(r.contact_name),
      talkSeconds: count(r.talk_seconds),
      userId: text(r.user_id),
      userName: text(r.user_name),
    });
  }
  return out;
}

function range(v: unknown): CallStatsRange {
  const r = isRow(v) ? v : {};
  return {
    from: text(r.from),
    to: text(r.to),
    tz: text(r.tz),
    previousFrom: text(r.previous_from),
    previousTo: text(r.previous_to),
  };
}

/**
 * pbx_call_stats's object, read defensively: a bad or missing count is
 * 0, a bad or missing average or maximum null, a list that is not one
 * empty. null when the value is not an object at all. An unknown scope
 * reads as 'self', the narrowest.
 */
export function parseCallStats(value: unknown): CallStats | null {
  if (!isRow(value)) return null;
  const scope = (CALL_STATS_SCOPES as readonly unknown[]).includes(value.scope)
    ? (value.scope as CallStatsScope)
    : 'self';
  return {
    summary: summary(value.summary),
    previous: summary(value.previous),
    byDay: byDay(value.by_day),
    byHour: byHour(value.by_hour),
    talkBuckets: talkBuckets(value.talk_buckets),
    outcomes: outcomes(value.outcomes),
    people: people(value.people),
    topNumbers: topNumbers(value.top_numbers),
    longest: longest(value.longest),
    range: range(value.range),
    scope,
    userId: text(value.user_id),
  };
}

// ---------- What the page shows ----------

/** "1h 02m", "4m 05s", "35s"; an em dash for no figure. */
export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  )
    return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** A 0..1 ratio as "73%" (`digits` decimals); an em dash for no figure. */
export function formatPercent(
  ratio: number | null | undefined,
  digits = 0
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio))
    return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export interface CallStatsDelta {
  /** current − previous. */
  abs: number;
  /** abs / previous as a ratio (0.25 = 25%); null when previous is 0. */
  pct: number | null;
  direction: 'up' | 'down' | 'flat';
}

/**
 * How a figure moved from the previous period; null when either side
 * has no figure (an average over no calls, an answer rate with no
 * incoming call).
 */
export function delta(
  current: number | null | undefined,
  previous: number | null | undefined
): CallStatsDelta | null {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  )
    return null;
  const diff = current - previous;
  // Ratios differ by float noise: 0.1 + 0.2 is not 0.3.
  const abs = Math.abs(diff) < 1e-9 ? 0 : diff;
  return {
    abs,
    pct: previous === 0 ? null : abs / previous,
    direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat',
  };
}
