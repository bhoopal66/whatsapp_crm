// ============================================================
// The Funnel report (funnel_report, migration 254), typed and
// defended. The function returns one jsonb document; this turns it into
// the shapes the page and the CSV export use, with every count a
// non-negative whole number, so a missing or junk field shows as 0
// instead of NaN. Plus the query-parameter rules both routes share and
// the conversion arithmetic the page shows.
//
// Pure: no I/O. The API routes and the client page both import it.
// docs/funnel-report.md is the contract.
// ============================================================

import { LEAD_SOURCES } from '@/lib/contacts/lead-source';
import type { CsvCell } from '@/lib/csv/build';
import {
  RANGE_PRESETS,
  isRangePreset,
  type RangePreset,
} from '@/lib/team-activity/range';

/** The funnel, top to bottom. */
export const FUNNEL_STAGES = [
  'new_chats',
  'interested',
  'case_opened',
  'submitted',
  'approved',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Case outcomes shown beside the funnel, not in it. */
export const FUNNEL_SIDE_OUTCOMES = ['declined', 'withdrawn'] as const;
export type FunnelSideOutcome = (typeof FUNNEL_SIDE_OUTCOMES)[number];

export type FunnelMetric = FunnelStage | FunnelSideOutcome;
export const FUNNEL_METRICS: readonly FunnelMetric[] = [
  ...FUNNEL_STAGES,
  ...FUNNEL_SIDE_OUTCOMES,
];

/** The stages a bank row carries: a chat has no bank (254). */
export const FUNNEL_BANK_METRICS = [
  'case_opened',
  'submitted',
  'approved',
  'declined',
  'withdrawn',
] as const satisfies readonly FunnelMetric[];
export type FunnelBankMetric = (typeof FUNNEL_BANK_METRICS)[number];

export type FunnelCounts = Record<FunnelMetric, number>;
export type FunnelBankCounts = Record<FunnelBankMetric, number>;

/** 'none' is the filter value for "no lead source recorded". */
export const NO_LEAD_SOURCE = 'none';
/** Every lead-source filter value 254 accepts, in display order. */
export const FUNNEL_LEAD_SOURCES = [...LEAD_SOURCES, NO_LEAD_SOURCE] as const;
export type FunnelLeadSource = (typeof FUNNEL_LEAD_SOURCES)[number];

export interface FunnelRow {
  /** Lead source / auth user id / number id; null = none or unassigned. */
  key: string | null;
  /** Display name the SQL resolved; null when it found none. */
  name: string | null;
  counts: FunnelCounts;
}

export interface FunnelBankRow {
  key: string | null;
  name: string | null;
  counts: FunnelBankCounts;
}

export interface FunnelDay {
  /** YYYY-MM-DD in the account's time zone. */
  day: string;
  newChats: number;
  interested: number;
  caseOpened: number;
}

export interface FunnelOption {
  id: string;
  name: string | null;
}

export interface FunnelReport {
  /** The account's main "Interested" chat tag; null when none exists. */
  interestedTagId: string | null;
  /** True when 255's chat_tag_history log was consulted. */
  tagHistory: boolean;
  totals: FunnelCounts;
  bySource: FunnelRow[];
  byAgent: FunnelRow[];
  byNumber: FunnelRow[];
  byBank: FunnelBankRow[];
  daily: FunnelDay[];
  options: {
    agents: FunnelOption[];
    numbers: FunnelOption[];
    banks: FunnelOption[];
  };
}

// ---------- parsing ----------

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A count: a finite, non-negative whole number, else 0. */
function count(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function countsOf(row: Record<string, unknown>): FunnelCounts {
  const out = {} as FunnelCounts;
  for (const m of FUNNEL_METRICS) out[m] = count(row[m]);
  return out;
}

function bankCountsOf(row: Record<string, unknown>): FunnelBankCounts {
  const out = {} as FunnelBankCounts;
  for (const m of FUNNEL_BANK_METRICS) out[m] = count(row[m]);
  return out;
}

function rowsOf(value: unknown): FunnelRow[] {
  return list(value)
    .filter((v) => v && typeof v === 'object' && !Array.isArray(v))
    .map((v) => {
      const r = record(v);
      return { key: text(r.key), name: text(r.name), counts: countsOf(r) };
    });
}

function optionsOf(value: unknown): FunnelOption[] {
  const out: FunnelOption[] = [];
  const seen = new Set<string>();
  for (const v of list(value)) {
    const r = record(v);
    const id = text(r.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: text(r.name) });
  }
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The RPC's jsonb, whatever came back, as a FunnelReport. */
export function parseFunnelReport(raw: unknown): FunnelReport {
  const r = record(raw);
  const options = record(r.options);
  return {
    interestedTagId: text(r.interested_tag_id),
    tagHistory: r.tag_history === true,
    totals: countsOf(record(r.totals)),
    bySource: rowsOf(r.by_source),
    byAgent: rowsOf(r.by_agent),
    byNumber: rowsOf(r.by_number),
    byBank: list(r.by_bank)
      .filter((v) => v && typeof v === 'object' && !Array.isArray(v))
      .map((v) => {
        const b = record(v);
        return {
          key: text(b.key),
          name: text(b.name),
          counts: bankCountsOf(b),
        };
      }),
    daily: list(r.daily)
      .map(record)
      .filter((d) => typeof d.day === 'string' && DAY_RE.test(d.day))
      .map((d) => ({
        day: d.day as string,
        newChats: count(d.new_chats),
        interested: count(d.interested),
        caseOpened: count(d.case_opened),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    options: {
      agents: optionsOf(options.agents),
      numbers: optionsOf(options.numbers),
      banks: optionsOf(options.banks),
    },
  };
}

/** The local calendar day (YYYY-MM-DD) of `instant` in `timeZone`. */
export function zonedDay(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Longest run of days the daily chart fills in (254 caps at 400). */
const MAX_FILLED_DAYS = 401;

/**
 * Every day from `fromDay` to `toDay` (both YYYY-MM-DD, inclusive), the
 * report's figures where it has them and zeros elsewhere: the SQL lists
 * only days with a chat, and a chart that skips the quiet days reads
 * wrong. Days outside the span are kept, in order. Bad bounds return
 * the input unchanged.
 */
export function fillFunnelDays(
  daily: readonly FunnelDay[],
  fromDay: string,
  toDay: string
): FunnelDay[] {
  if (!DAY_RE.test(fromDay) || !DAY_RE.test(toDay) || fromDay > toDay) {
    return [...daily];
  }
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: FunnelDay[] = [];
  const cursor = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    return [...daily];
  }
  while (cursor <= end && out.length < MAX_FILLED_DAYS) {
    const day = cursor.toISOString().slice(0, 10);
    out.push(
      byDay.get(day) ?? { day, newChats: 0, interested: 0, caseOpened: 0 }
    );
    byDay.delete(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...out, ...byDay.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0
  );
}

// ---------- conversion ----------

export interface ConversionStep {
  stage: FunnelStage;
  count: number;
  /** % of the stage above (one decimal); null for the first stage or a 0 denominator. */
  ofPrevious: number | null;
  /** % of new chats (one decimal); null when there are no new chats. */
  ofNewChats: number | null;
}

/** `part` as a percentage of `whole`, one decimal; null when whole is 0. */
export function percentOf(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0 || !Number.isFinite(part)) {
    return null;
  }
  return Math.round((part / whole) * 1000) / 10;
}

/** Each funnel stage with its count and its two conversion rates. */
export function conversionSteps(
  totals: Partial<FunnelCounts> | null | undefined
): ConversionStep[] {
  const t = totals ?? {};
  const newChats = count(t.new_chats);
  let previous: number | null = null;
  return FUNNEL_STAGES.map((stage) => {
    const n = count(t[stage]);
    const step: ConversionStep = {
      stage,
      count: n,
      ofPrevious: previous === null ? null : percentOf(n, previous),
      ofNewChats: percentOf(n, newChats),
    };
    previous = n;
    return step;
  });
}

// ---------- filters ----------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 122's `case_banks_code_check`. */
const BANK_CODE_RE = /^[A-Z0-9_]{2,32}$/;

export const DEFAULT_FUNNEL_RANGE: RangePreset = '30d';
export const FUNNEL_RANGE_PRESETS = RANGE_PRESETS;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isBankCode(value: unknown): value is string {
  return typeof value === 'string' && BANK_CODE_RE.test(value);
}

export function isFunnelLeadSource(value: unknown): value is FunnelLeadSource {
  return (
    typeof value === 'string' &&
    (FUNNEL_LEAD_SOURCES as readonly string[]).includes(value)
  );
}

export interface FunnelFilters {
  range: RangePreset;
  leadSource: FunnelLeadSource | null;
  /** An auth user id (conversations.assigned_agent_id). */
  agent: string | null;
  bank: string | null;
  /** A whatsapp_config id. */
  channel: string | null;
  /** The viewer's zone, unvalidated: the route checks it. */
  tz: string | null;
}

export type FunnelFilterField =
  'range' | 'lead_source' | 'agent' | 'bank' | 'channel';

export type FunnelFiltersResult =
  | { ok: true; filters: FunnelFilters }
  | { ok: false; field: FunnelFilterField };

/** A parameter's value, with absent, blank and 'all' meaning no filter. */
function param(params: URLSearchParams, name: string): string | null {
  const v = params.get(name)?.trim();
  return v && v !== 'all' ? v : null;
}

/** The query parameters both funnel routes take, validated. */
export function parseFunnelFilters(
  params: URLSearchParams
): FunnelFiltersResult {
  const range = params.get('range') ?? DEFAULT_FUNNEL_RANGE;
  if (!isRangePreset(range)) return { ok: false, field: 'range' };

  const leadSource = param(params, 'lead_source');
  if (leadSource !== null && !isFunnelLeadSource(leadSource)) {
    return { ok: false, field: 'lead_source' };
  }
  const agent = param(params, 'agent');
  if (agent !== null && !isUuid(agent)) return { ok: false, field: 'agent' };
  const bank = param(params, 'bank');
  if (bank !== null && !isBankCode(bank)) return { ok: false, field: 'bank' };
  const channel = param(params, 'channel');
  if (channel !== null && !isUuid(channel)) {
    return { ok: false, field: 'channel' };
  }
  return {
    ok: true,
    filters: {
      range,
      leadSource,
      agent,
      bank,
      channel,
      tz: params.get('tz') || null,
    },
  };
}

/** The query string for the report and its export, filters left out when unset. */
export function funnelQueryString(filters: FunnelFilters): string {
  const p = new URLSearchParams({ range: filters.range });
  if (filters.leadSource) p.set('lead_source', filters.leadSource);
  if (filters.agent) p.set('agent', filters.agent);
  if (filters.bank) p.set('bank', filters.bank);
  if (filters.channel) p.set('channel', filters.channel);
  if (filters.tz) p.set('tz', filters.tz);
  return p.toString();
}

// ---------- CSV ----------

export interface FunnelCsvLabels {
  /** Column headings. */
  breakdown: string;
  item: string;
  metrics: Record<FunnelMetric, string>;
  /** The values of the Breakdown column. */
  sections: {
    total: string;
    ofPrevious: string;
    ofNewChats: string;
    source: string;
    agent: string;
    number: string;
    bank: string;
  };
  /** The Item of the total and conversion rows. */
  all: string;
  unassigned: string;
  noNumber: string;
  noBank: string;
  /** A lead source's label ('none' included). */
  source: (key: string) => string;
}

/**
 * One long table, stages as columns: the totals, the two conversion
 * rows (percentages), then one row per lead source, agent, number and
 * bank. A bank row leaves New chats and Interested empty: those stages
 * have no bank.
 */
export function funnelCsvRows(
  report: FunnelReport,
  labels: FunnelCsvLabels
): { header: string[]; rows: CsvCell[][] } {
  const header = [
    labels.breakdown,
    labels.item,
    ...FUNNEL_METRICS.map((m) => labels.metrics[m]),
  ];
  const rows: CsvCell[][] = [];
  const countsRow = (section: string, item: string, c: FunnelCounts) =>
    rows.push([section, item, ...FUNNEL_METRICS.map((m) => c[m])]);

  countsRow(labels.sections.total, labels.all, report.totals);
  const steps = conversionSteps(report.totals);
  const pct = (pick: (s: ConversionStep) => number | null): CsvCell[] =>
    FUNNEL_METRICS.map((m) => {
      const step = steps.find((s) => s.stage === m);
      return step ? pick(step) : null;
    });
  rows.push([
    labels.sections.ofPrevious,
    labels.all,
    ...pct((s) => s.ofPrevious),
  ]);
  rows.push([
    labels.sections.ofNewChats,
    labels.all,
    ...pct((s) => s.ofNewChats),
  ]);

  for (const r of report.bySource) {
    countsRow(
      labels.sections.source,
      labels.source(r.key ?? NO_LEAD_SOURCE),
      r.counts
    );
  }
  for (const r of report.byAgent) {
    countsRow(
      labels.sections.agent,
      r.name ?? (r.key ? r.key : labels.unassigned),
      r.counts
    );
  }
  for (const r of report.byNumber) {
    countsRow(
      labels.sections.number,
      r.name ?? (r.key ? r.key : labels.noNumber),
      r.counts
    );
  }
  for (const r of report.byBank) {
    rows.push([
      labels.sections.bank,
      r.name ?? r.key ?? labels.noBank,
      ...FUNNEL_METRICS.map((m) =>
        (FUNNEL_BANK_METRICS as readonly string[]).includes(m)
          ? r.counts[m as FunnelBankMetric]
          : null
      ),
    ]);
  }
  return { header, rows };
}
