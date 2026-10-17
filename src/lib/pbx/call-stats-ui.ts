// The Call report page's pure logic (module 015, /calls/report): the
// URL it keeps its period and person in, which way each tile's change
// is good, the weekday x hour grid, the people table's sort, the call
// list's paging, and the CSV export. Safe for the browser.

import {
  CALL_STATS_PERIODS,
  checkCustomDays,
  isCallStatsPeriod,
  type CallStatsPeriod,
} from '@/lib/pbx/call-report';
import type {
  CallStats,
  CallStatsDelta,
  CallStatsHourCell,
  CallStatsPerson,
  CallStatsScope,
  CallStatsSummary,
} from '@/lib/pbx/call-stats';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- The URL ----------

export interface ReportParams {
  period: CallStatsPeriod;
  /** YYYY-MM-DD, custom only (null otherwise or when unusable). */
  from: string | null;
  to: string | null;
  /** The person drilled into, else null (everyone in scope). */
  user: string | null;
}

/**
 * `?period=&from=&to=&user=` as the page reads it: an unknown period is
 * this month, a custom period with bad days keeps the days null (the
 * page then asks for them), a malformed person is everyone.
 */
export function readReportParams(
  get: (key: string) => string | null
): ReportParams {
  const raw = get('period');
  const period: CallStatsPeriod = isCallStatsPeriod(raw) ? raw : 'month';
  const user = get('user');
  const days =
    period === 'custom' && checkCustomDays(get('from'), get('to')) === null
      ? { from: get('from'), to: get('to') }
      : { from: null, to: null };
  return { period, ...days, user: user && UUID_RE.test(user) ? user : null };
}

/** The query string for `p`, without the `?`; month is the default. */
export function reportSearch(p: ReportParams): string {
  const q = new URLSearchParams();
  if (p.period !== 'month') q.set('period', p.period);
  if (p.period === 'custom' && p.from && p.to) {
    q.set('from', p.from);
    q.set('to', p.to);
  }
  if (p.user) q.set('user', p.user);
  return q.toString();
}

/** The stats request's query, or null while a custom period lacks days. */
export function statsQuery(p: ReportParams, tz: string): string | null {
  if (p.period === 'custom' && !(p.from && p.to)) return null;
  const q = new URLSearchParams({ period: p.period });
  if (p.period === 'custom') {
    q.set('from', p.from!);
    q.set('to', p.to!);
  }
  q.set('tz', tz);
  if (p.user) q.set('user', p.user);
  return q.toString();
}

export { CALL_STATS_PERIODS };

// ---------- KPI tiles ----------

export const KPI_KEYS = [
  'calls',
  'inboundAnswered',
  'outbound',
  'missed',
  'answerRate',
  'talkTotal',
  'talkAverage',
  'longest',
  'ringAverage',
  'uniqueNumbers',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

/** The figure a tile compares with the previous period. */
export function kpiValue(s: CallStatsSummary, key: KpiKey): number | null {
  switch (key) {
    case 'calls':
      return s.calls;
    case 'inboundAnswered':
      return s.inboundAnswered;
    case 'outbound':
      return s.outboundTotal;
    case 'missed':
      return s.missed;
    case 'answerRate':
      return s.answerRate;
    case 'talkTotal':
      return s.talkSecondsTotal;
    case 'talkAverage':
      return s.avgTalkSeconds;
    case 'longest':
      return s.longestTalkSeconds;
    case 'ringAverage':
      return s.avgRingSeconds;
    case 'uniqueNumbers':
      return s.uniqueNumbers;
  }
}

/** Fewer missed calls and a shorter wait to be answered are better. */
const LOWER_IS_BETTER: ReadonlySet<KpiKey> = new Set(['missed', 'ringAverage']);

export type DeltaTone = 'good' | 'bad' | 'neutral';

/** How a tile colours its change: by the figure's good direction. */
export function deltaTone(key: KpiKey, d: CallStatsDelta | null): DeltaTone {
  if (!d || d.direction === 'flat') return 'neutral';
  const up = d.direction === 'up';
  return up !== LOWER_IS_BETTER.has(key) ? 'good' : 'bad';
}

// ---------- The daily trend ----------

/** One day of the trend chart: stacked calls, talk minutes as a line. */
export interface DailyPoint {
  day: string;
  inboundAnswered: number;
  outbound: number;
  missed: number;
  talkMinutes: number;
}

/** The stacked series, bottom first, with their chart and legend colours. */
export const DAILY_SERIES = [
  { key: 'inboundAnswered', fill: 'fill-emerald-500', bg: 'bg-emerald-500' },
  { key: 'outbound', fill: 'fill-blue-500', bg: 'bg-blue-500' },
  { key: 'missed', fill: 'fill-red-500', bg: 'bg-red-500' },
] as const;

// ---------- Busiest times ----------

export interface HeatCell {
  dow: number;
  hour: number;
  calls: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

/**
 * The weekday x hour grid, Monday first, every hour 0-23, zero-filled
 * (the API sends non-zero cells only), and the busiest cell's calls for
 * the colour scale. A cell out of range is ignored.
 */
export function heatmapMatrix(cells: CallStatsHourCell[]): {
  rows: HeatCell[][];
  max: number;
} {
  const rows: HeatCell[][] = Array.from({ length: 7 }, (_, i) =>
    Array.from({ length: 24 }, (_, hour) => ({
      dow: i + 1,
      hour,
      calls: 0,
      answered: 0,
      missed: 0,
      talkSeconds: 0,
    }))
  );
  let max = 0;
  for (const c of cells) {
    if (!(c.dow >= 1 && c.dow <= 7 && c.hour >= 0 && c.hour <= 23)) continue;
    const cell = rows[c.dow - 1][c.hour];
    cell.calls += c.calls;
    cell.answered += c.answered;
    cell.missed += c.missed;
    cell.talkSeconds += c.talkSeconds;
    max = Math.max(max, cell.calls);
  }
  return { rows, max };
}

/** 0 for an empty cell, else 1-4 by its share of the busiest. */
export function heatLevel(calls: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (calls <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((calls / max) * 4))) as
    1 | 2 | 3 | 4;
}

// ---------- The people table ----------

export const PEOPLE_SORT_KEYS = [
  'name',
  'extension',
  'calls',
  'inboundAnswered',
  'outbound',
  'missed',
  'answerRate',
  'talkTotal',
  'talkAverage',
  'longest',
  'ringAverage',
] as const;
export type PeopleSortKey = (typeof PEOPLE_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

function sortValue(p: CallStatsPerson, key: PeopleSortKey) {
  if (key === 'name') return p.fullName?.toLocaleLowerCase() ?? null;
  if (key === 'extension') return p.extension;
  return kpiValue(p, key);
}

/**
 * The rows sorted by `key`; a missing figure sorts last either way, and
 * the ring groups / unassigned row ('none') always comes last.
 */
export function sortPeople(
  people: CallStatsPerson[],
  key: PeopleSortKey,
  dir: SortDir
): CallStatsPerson[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...people].sort((a, b) => {
    if ((a.kind === 'none') !== (b.kind === 'none'))
      return a.kind === 'none' ? 1 : -1;
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    if (typeof x === 'string' || typeof y === 'string')
      return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  });
}

// ---------- The call list ----------

/** The list's page size ("Load more"). */
export const CALL_LIST_PAGE = 100;

/** What the list asks /api/pbx/calls for: its own, or all + the person. */
export function callListQuery(
  scope: CallStatsScope,
  userId: string | null,
  range: { from: string; to: string },
  limit = CALL_LIST_PAGE
): string {
  const q = new URLSearchParams();
  if (scope === 'self') q.set('scope', 'mine');
  else {
    q.set('scope', 'all');
    if (userId) q.set('userId', userId);
  }
  q.set('from', range.from);
  q.set('to', range.to);
  q.set('limit', String(limit));
  return q.toString();
}

/**
 * The next page's `to` (exclusive): just past the oldest call listed,
 * so a call sharing its start is read again rather than skipped;
 * mergeCalls drops the repeat.
 */
export function nextPageTo(calls: { startedAt: string }[]): string | null {
  let oldest = Infinity;
  for (const c of calls) oldest = Math.min(oldest, Date.parse(c.startedAt));
  return Number.isFinite(oldest) ? new Date(oldest + 1).toISOString() : null;
}

/** `more` appended to `calls`, without the ones already listed. */
export function mergeCalls<T extends { id: string }>(calls: T[], more: T[]) {
  const seen = new Set(calls.map((c) => c.id));
  return [...calls, ...more.filter((c) => !seen.has(c.id))];
}

// ---------- CSV ----------

export type CsvValue = string | number | null | undefined;

/**
 * One CSV cell. Quoted when it holds a comma, quote or line break
 * (quotes doubled); a text starting with = + - @ (or a tab or carriage
 * return) is prefixed with ' so a spreadsheet shows it rather than
 * running it as a formula. Numbers are written as they are.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text, CRLF line ends, as spreadsheets expect. */
export function toCsv(rows: CsvValue[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The labels the report CSV is written with (the page's i18n). */
export interface StatsCsvLabels {
  section: { summary: string; days: string; people: string };
  metric: string;
  current: string;
  previous: string;
  kpi: Record<KpiKey, string>;
  day: string;
  dayColumns: {
    calls: string;
    inboundAnswered: string;
    outbound: string;
    outboundAnswered: string;
    missed: string;
    talkSeconds: string;
  };
  person: string;
  extension: string;
  peopleColumns: Record<Exclude<PeopleSortKey, 'name' | 'extension'>, string>;
  unassigned: string;
  unnamed: string;
  total: string;
}

const PEOPLE_FIGURES = PEOPLE_SORT_KEYS.filter(
  (k): k is Exclude<PeopleSortKey, 'name' | 'extension'> =>
    k !== 'name' && k !== 'extension'
);

/**
 * The report as CSV rows: the summary (this period and the previous),
 * the days, and, when there is one, the people table with its totals.
 * Seconds stay seconds and the answer rate a 0-1 ratio, so the file
 * sums and charts as it is.
 */
export function statsCsvRows(s: CallStats, L: StatsCsvLabels): CsvValue[][] {
  const rows: CsvValue[][] = [
    [L.section.summary],
    [L.metric, L.current, L.previous],
    ...KPI_KEYS.map((k) => [
      L.kpi[k],
      kpiValue(s.summary, k),
      kpiValue(s.previous, k),
    ]),
    [],
    [L.section.days],
    [
      L.day,
      L.dayColumns.calls,
      L.dayColumns.inboundAnswered,
      L.dayColumns.outbound,
      L.dayColumns.outboundAnswered,
      L.dayColumns.missed,
      L.dayColumns.talkSeconds,
    ],
    ...s.byDay.map((d) => [
      d.day,
      d.calls,
      d.inboundAnswered,
      d.outbound,
      d.outboundAnswered,
      d.missed,
      d.talkSeconds,
    ]),
  ];
  if (s.people) {
    rows.push(
      [],
      [L.section.people],
      [L.person, L.extension, ...PEOPLE_FIGURES.map((k) => L.peopleColumns[k])]
    );
    for (const p of s.people)
      rows.push([
        p.kind === 'none' ? L.unassigned : (p.fullName ?? L.unnamed),
        p.extension,
        ...PEOPLE_FIGURES.map((k) => kpiValue(p, k)),
      ]);
    rows.push([
      L.total,
      null,
      ...PEOPLE_FIGURES.map((k) => kpiValue(s.summary, k)),
    ]);
  }
  return rows;
}
