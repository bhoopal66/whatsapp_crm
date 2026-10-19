/**
 * The bank page's Cases and Dashboard tabs (module 019): pure helpers
 * behind bank-cases-tab.tsx and bank-dashboard-tab.tsx. Client-safe: it
 * only takes TYPES from lib/cases/dashboard (server code), so the reason
 * codes are restated here and dashboard-ui.test.ts keeps them equal.
 */
import type {
  BankDashboardData,
  OutcomeReasonCode,
} from '@/lib/cases/dashboard';

import type { BankCase } from './ui';

/** 127's reason codes, in the order the charts list them. */
export const REASON_CODES: readonly OutcomeReasonCode[] = [
  'INCOMPLETE_DOCS',
  'CREDIT_POLICY',
  'INCOME_INSUFFICIENT',
  'KYC_AML',
  'CUSTOMER_WITHDREW',
  'OTHER',
];

export const CASE_FILTERS = ['all', 'open', 'closed'] as const;
export type CaseFilter = (typeof CASE_FILTERS)[number];

/** The approval rate as a percent with one decimal; '—' when unknown. */
export function percent(rate: number | null, locale?: string): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate);
}

/** Stages in `order` first, then any other stage alphabetically. */
function ordered(stages: string[], order: readonly string[]): string[] {
  const known = order.filter((s) => stages.includes(s));
  const rest = stages
    .filter((s) => !order.includes(s))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

export interface StagePoint {
  stage: string;
  count: number;
}

/** Cases by stage, in the bank's stage order; stages with no case left out. */
export function stageSeries(
  casesByStage: Record<string, number>,
  order: readonly string[]
): StagePoint[] {
  const stages = Object.keys(casesByStage).filter((s) => casesByStage[s] > 0);
  return ordered(stages, order).map((stage) => ({
    stage,
    count: casesByStage[stage],
  }));
}

export interface AvgDaysPoint {
  stage: string;
  /** Rounded to one decimal. */
  avgDays: number;
  intervals: number;
}

/** Average days per stage, in stage order; stages with no interval left out. */
export function avgDaysSeries(
  avgDaysPerStage: BankDashboardData['avgDaysPerStage'],
  order: readonly string[]
): AvgDaysPoint[] {
  const stages = Object.keys(avgDaysPerStage).filter(
    (s) => avgDaysPerStage[s].intervals > 0
  );
  return ordered(stages, order).map((stage) => ({
    stage,
    avgDays: Math.round(avgDaysPerStage[stage].avgDays * 10) / 10,
    intervals: avgDaysPerStage[stage].intervals,
  }));
}

export interface ReasonPoint {
  code: OutcomeReasonCode;
  label: string;
  count: number;
}

/** Reason counts in REASON_CODES order, labelled; zero counts left out. */
export function reasonSeries(
  reasons: Partial<Record<OutcomeReasonCode, number>>,
  labels: Record<OutcomeReasonCode, string>
): ReasonPoint[] {
  return REASON_CODES.filter((code) => (reasons[code] ?? 0) > 0).map(
    (code) => ({ code, label: labels[code], count: reasons[code] ?? 0 })
  );
}

const openedMs = (c: BankCase): number => {
  const t = c.openedAt ? Date.parse(c.openedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** Open and closed cases, each newest (by opening) first. */
export function splitCases(cases: readonly BankCase[]): {
  open: BankCase[];
  closed: BankCase[];
} {
  const sorted = [...cases].sort(
    (a, b) => openedMs(b) - openedMs(a) || a.caseId.localeCompare(b.caseId)
  );
  return {
    open: sorted.filter((c) => !c.closedAt),
    closed: sorted.filter((c) => Boolean(c.closedAt)),
  };
}

/** The rows a filter shows: open cases first, then closed. */
export function visibleCases(
  split: { open: BankCase[]; closed: BankCase[] },
  filter: CaseFilter
): BankCase[] {
  if (filter === 'open') return split.open;
  if (filter === 'closed') return split.closed;
  return [...split.open, ...split.closed];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) out[k] = n(x);
  return out;
}

/** GET /api/banks/[id]/dashboard; null when the body is unusable. */
export function parseDashboard(json: unknown): BankDashboardData | null {
  if (!isObj(json) || !isObj(json.dashboard)) return null;
  const d = json.dashboard;
  const avg: BankDashboardData['avgDaysPerStage'] = {};
  if (isObj(d.avgDaysPerStage))
    for (const [stage, v] of Object.entries(d.avgDaysPerStage))
      if (isObj(v) && typeof v.avgDays === 'number')
        avg[stage] = { avgDays: n(v.avgDays), intervals: n(v.intervals) };
  const a = isObj(d.approval) ? d.approval : {};
  const reasons = (v: unknown) => {
    const all = counts(v);
    const out: Partial<Record<OutcomeReasonCode, number>> = {};
    for (const code of REASON_CODES) if (code in all) out[code] = all[code];
    return out;
  };
  return {
    scope: d.scope === 'all' ? 'all' : 'own',
    totalCases: n(d.totalCases),
    casesByStage: counts(d.casesByStage),
    avgDaysPerStage: avg,
    approval: {
      approved: n(a.approved),
      declined: n(a.declined),
      withdrawn: n(a.withdrawn),
      rate:
        typeof a.rate === 'number' && Number.isFinite(a.rate) ? a.rate : null,
    },
    declinedReasons: reasons(d.declinedReasons),
    withdrawnReasons: reasons(d.withdrawnReasons),
    overdueCount: n(d.overdueCount),
    amountInPipeline:
      typeof d.amountInPipeline === 'string' &&
      /^-?\d+(?:\.\d+)?$/.test(d.amountInPipeline)
        ? d.amountInPipeline
        : '0.00',
  };
}
