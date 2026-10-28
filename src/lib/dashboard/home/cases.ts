import {
  DEFAULT_STAGES,
  EMPTY_FILTERS,
  filterParams,
  type InboxFilters,
  type InboxRow,
} from '@/lib/cases/ui';

// ------------------------------------------------------------
// The home Cases card's figures, from the one open-cases list the page
// loads (GET /api/cases, already scoped to the person's role). Pure.
// ------------------------------------------------------------

/** One figure: the count, and whether more may exist than were read. */
export interface CaseFigure {
  count: number;
  /** The list was cut at its limit and this count may be higher. */
  atLeast: boolean;
}

export interface CaseStageCount {
  stage: string;
  count: number;
  /** count / the largest stage's count, 0..1: the bar's length. */
  share: number;
}

export interface CasesSummary {
  /** Open cases that are not leads. */
  open: CaseFigure;
  leads: CaseFigure;
  overdue: CaseFigure;
  dueSoon: CaseFigure;
  customerWaiting: CaseFigure;
  documentsMissing: CaseFigure;
  bankQueries: CaseFigure;
  /** The first `URGENT_LIMIT` rows, in the server's most-overdue order. */
  urgent: InboxRow[];
  /** Cases per stage, in the cases module's stage order, others after. */
  byStage: CaseStageCount[];
}

export const URGENT_LIMIT = 5;

/**
 * Count the open cases. Leads are counted apart from Open; every other
 * figure counts leads too, because the /cases view it links to lists
 * them. When `truncated`, every count is a floor, except SLA overdue:
 * rows arrive most overdue first, so unless every row read is overdue,
 * all the overdue ones were read.
 */
export function summarizeCases(
  rows: readonly InboxRow[],
  truncated: boolean
): CasesSummary {
  let open = 0;
  let leads = 0;
  let overdue = 0;
  let dueSoon = 0;
  let customerWaiting = 0;
  let documentsMissing = 0;
  let bankQueries = 0;
  const stages = new Map<string, number>();
  for (const r of rows) {
    if (r.isLead) leads++;
    else open++;
    if (r.slaState === 'overdue') overdue++;
    if (r.slaState === 'due_soon') dueSoon++;
    if (r.customerWaiting) customerWaiting++;
    if (r.documentsMissing > 0) documentsMissing++;
    if (r.bankQueryOpen) bankQueries++;
    const stage = r.stage || '—';
    stages.set(stage, (stages.get(stage) ?? 0) + 1);
  }
  const fig = (count: number): CaseFigure => ({ count, atLeast: truncated });
  const max = Math.max(0, ...stages.values());
  return {
    open: fig(open),
    leads: fig(leads),
    overdue: {
      count: overdue,
      atLeast: truncated && overdue === rows.length,
    },
    dueSoon: fig(dueSoon),
    customerWaiting: fig(customerWaiting),
    documentsMissing: fig(documentsMissing),
    bankQueries: fig(bankQueries),
    urgent: rows.slice(0, URGENT_LIMIT),
    byStage: [...stages.entries()]
      .sort(([a], [b]) => stageRank(a) - stageRank(b) || a.localeCompare(b))
      .map(([stage, count]) => ({ stage, count, share: count / max })),
  };
}

/** A stage's place in `DEFAULT_STAGES`; a bank's own stage goes last. */
function stageRank(stage: string): number {
  const i = DEFAULT_STAGES.indexOf(stage);
  return i === -1 ? DEFAULT_STAGES.length : i;
}

/** "12", or "12+" when more may exist. */
export function formatFigure(f: CaseFigure): string {
  return f.atLeast ? `${f.count}+` : String(f.count);
}

/** The cases inbox narrowed by these filters (its own URL parameters). */
export function casesHref(filters: Partial<InboxFilters> = {}): string {
  const qs = filterParams({ ...EMPTY_FILTERS, ...filters }).toString();
  return qs ? `/cases?${qs}` : '/cases';
}
