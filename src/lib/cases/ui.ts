/**
 * The Cases inbox screen (module 019): the pure decisions behind /cases.
 * Client-safe: no store, no server import. The filters live in the page
 * URL so a link reproduces the view; `filtersFromSearch` reads them back
 * defensively (an unknown value is dropped, not sent), and `inboxUrl`
 * turns them into GET /api/cases (lib/cases/http.ts parseInboxQuery).
 */
import { PRIORITIES, type CasePriority } from './types';

export type InboxSort = 'most_overdue' | 'due_soonest' | 'stalest';
export const INBOX_SORTS: readonly InboxSort[] = [
  'most_overdue',
  'due_soonest',
  'stalest',
];

export type InboxSlaState = 'on_track' | 'due_soon' | 'overdue';
export const SLA_STATES: readonly InboxSlaState[] = [
  'on_track',
  'due_soon',
  'overdue',
];

export { PRIORITIES };

/**
 * 130's case_default_stages(), in order: the stage filter's options.
 * ui.test.ts reads the migration and keeps the two equal.
 */
export const DEFAULT_STAGES: readonly string[] = [
  'Interested',
  'Data collection',
  'Review',
  'Submitted',
  'Bank acknowledged',
  'Documents requested',
  'Documents received',
  'Under review',
  'Query raised',
  'Query answered',
  'Approved',
  'Declined',
  'Withdrawn',
  'Closed',
];

/**
 * Each stage's chip colour, by what the stage means: sky for a lead's
 * stages, blue/indigo once with the bank, amber while documents are
 * awaited, teal once received, violet under review, orange for an open
 * bank query, cyan once answered, green approved, red declined, grey
 * finished. Full class strings (Tailwind scans for literals); each raw
 * hue has its own dark-mode shade. A bank's own stage outside this list
 * gets STAGE_CHIP_OTHER.
 */
const SKY =
  'bg-sky-100 text-sky-800 ring-1 ring-sky-600/20 ring-inset dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30';
const BLUE = 'bg-info-soft text-info ring-1 ring-info/30 ring-inset';
const INDIGO =
  'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-600/20 ring-inset dark:bg-indigo-400/15 dark:text-indigo-300 dark:ring-indigo-400/30';
const AMBER = 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset';
const TEAL =
  'bg-teal-100 text-teal-800 ring-1 ring-teal-600/20 ring-inset dark:bg-teal-400/15 dark:text-teal-300 dark:ring-teal-400/30';
const VIOLET =
  'bg-violet-100 text-violet-800 ring-1 ring-violet-600/20 ring-inset dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30';
const ORANGE =
  'bg-orange-100 text-orange-800 ring-1 ring-orange-600/20 ring-inset dark:bg-orange-400/15 dark:text-orange-300 dark:ring-orange-400/30';
const CYAN =
  'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-600/20 ring-inset dark:bg-cyan-400/15 dark:text-cyan-300 dark:ring-cyan-400/30';
const GREEN = 'bg-success-soft text-success ring-1 ring-success/30 ring-inset';
const RED =
  'bg-destructive-soft text-destructive ring-1 ring-destructive/30 ring-inset';
const GREY = 'bg-muted text-muted-foreground ring-1 ring-border ring-inset';

export const STAGE_CHIP: Readonly<Record<string, string>> = {
  Interested: SKY,
  'Data collection': SKY,
  Review: SKY,
  Submitted: BLUE,
  'Bank acknowledged': INDIGO,
  'Documents requested': AMBER,
  'Documents received': TEAL,
  'Under review': VIOLET,
  'Query raised': ORANGE,
  'Query answered': CYAN,
  Approved: GREEN,
  Declined: RED,
  Withdrawn: GREY,
  Closed: GREY,
};

/**
 * The submission tracker's (Compass's) own status names, by what they
 * mean, keyed by `statusKey`: sky while the RO is still preparing it,
 * indigo in Taamul's own review, blue with the bank, violet under the
 * bank's review, amber waiting on the customer, orange sent back to the
 * RO, teal approved and awaiting fulfilment. A status not listed here
 * takes the colour of the stage it names, else the case's stage.
 */
export const TRACKER_STATUS_CHIP: Readonly<Record<string, string>> = {
  'to submit': SKY,
  'inhouse review': INDIGO,
  'in house review': INDIGO,
  'in-house review': INDIGO,
  submitted: BLUE,
  'bank review': VIOLET,
  'awaiting customer response': AMBER,
  'returned to ro': ORANGE,
  'awaiting fulfillment': TEAL,
  'awaiting fulfilment': TEAL,
  approved: GREEN,
  declined: RED,
  withdrawn: GREY,
  closed: GREY,
};

/** A status as a lookup key: `_` read as a space, blanks collapsed, case ignored. */
function statusKey(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const STAGE_BY_KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(STAGE_CHIP).map(([stage, cls]) => [statusKey(stage), cls])
);

export const STAGE_CHIP_OTHER =
  'bg-secondary text-secondary-foreground ring-1 ring-border ring-inset';

/** The chip classes for a stage (any bank's own stage included). */
export function stageChipClass(stage: string | null | undefined): string {
  return (
    (stage && Object.hasOwn(STAGE_CHIP, stage) && STAGE_CHIP[stage]) ||
    STAGE_CHIP_OTHER
  );
}

/**
 * What a case shows as its status: the submission tracker's status word
 * for word once it has sent one, else the CRM stage (a lead, or a case
 * the tracker has not reported on yet). Nothing is translated. The chip
 * colour is the tracker status's own (TRACKER_STATUS_CHIP), else that of
 * the stage the status names (137's rule: `_` read as a space, case
 * ignored), else the case's stage colour, so every chip is coloured.
 */
export function caseStatusView(c: {
  stage: string;
  submissionStatus: string | null;
}): { text: string; chipClass: string } {
  const status = c.submissionStatus?.trim();
  if (!status) return { text: c.stage, chipClass: stageChipClass(c.stage) };
  const key = statusKey(status);
  return {
    text: status,
    chipClass:
      (Object.hasOwn(TRACKER_STATUS_CHIP, key) && TRACKER_STATUS_CHIP[key]) ||
      STAGE_BY_KEY.get(key) ||
      stageChipClass(c.stage),
  };
}

/**
 * 130's case_presub_stages(): a lead's stages, before any submission.
 * Every stage list starts with exactly these, in this order.
 */
export const PRESUB_STAGES: readonly string[] = [
  'Interested',
  'Data collection',
  'Review',
];

/** 130's case_stage_is_presub(). */
export function isPresubStage(stage: string | null | undefined): boolean {
  return stage != null && PRESUB_STAGES.includes(stage);
}

/** 125's bound on `no_activity_days`. */
export const NO_ACTIVITY_DAYS_MAX = 3650;
/** What "No activity for N days" starts at when switched on. */
export const NO_ACTIVITY_DAYS_DEFAULT = 7;
export const INBOX_PAGE_SIZE = 50;

export interface InboxFilters {
  bank: string | null;
  stage: string | null;
  /** An agent's auth user id. */
  agent: string | null;
  priority: CasePriority | null;
  slaState: InboxSlaState | null;
  customerWaiting: boolean;
  documentsMissing: boolean;
  bankQueryOpen: boolean;
  includeClosed: boolean;
  noActivityDays: number | null;
  sort: InboxSort;
}

export const EMPTY_FILTERS: InboxFilters = {
  bank: null,
  stage: null,
  agent: null,
  priority: null,
  slaState: null,
  customerWaiting: false,
  documentsMissing: false,
  bankQueryOpen: false,
  includeClosed: false,
  noActivityDays: null,
  sort: 'most_overdue',
};

/** A whole number of days the inbox accepts (1..3650), else null. */
export function parseDays(v: string | null | undefined): number | null {
  const s = (v ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= NO_ACTIVITY_DAYS_MAX ? n : null;
}

const oneOf = <T extends string>(
  list: readonly T[],
  v: string | null
): T | null =>
  v !== null && (list as readonly string[]).includes(v) ? (v as T) : null;

const text = (v: string | null): string | null => {
  const s = (v ?? '').trim();
  return s ? s.slice(0, 200) : null;
};

/**
 * The page URL's query -> filters. Same parameter names as the API.
 * A toggle is on only for `true`; an unknown priority, SLA state or sort
 * and an out-of-range day count are dropped.
 */
export function filtersFromSearch(
  get: (key: string) => string | null
): InboxFilters {
  return {
    bank: text(get('bank')),
    stage: text(get('stage')),
    agent: text(get('agent')),
    priority: oneOf(PRIORITIES, get('priority')),
    slaState: oneOf(SLA_STATES, get('sla_state')),
    customerWaiting: get('customer_waiting') === 'true',
    documentsMissing: get('documents_missing') === 'true',
    bankQueryOpen: get('bank_query_open') === 'true',
    includeClosed: get('include_closed') === 'true',
    noActivityDays: parseDays(get('no_activity_days')),
    sort: oneOf(INBOX_SORTS, get('sort')) ?? 'most_overdue',
  };
}

/**
 * Filters -> query parameters, leaving out every default (a toggle that
 * is off is "no filter", never `false`; the default sort is implicit),
 * so the page URL stays short and the API sees only what was chosen.
 */
export function filterParams(f: InboxFilters): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.bank) qs.set('bank', f.bank);
  if (f.stage) qs.set('stage', f.stage);
  if (f.agent) qs.set('agent', f.agent);
  if (f.priority) qs.set('priority', f.priority);
  if (f.slaState) qs.set('sla_state', f.slaState);
  if (f.customerWaiting) qs.set('customer_waiting', 'true');
  if (f.documentsMissing) qs.set('documents_missing', 'true');
  if (f.bankQueryOpen) qs.set('bank_query_open', 'true');
  if (f.includeClosed) qs.set('include_closed', 'true');
  if (f.noActivityDays !== null)
    qs.set('no_activity_days', String(f.noActivityDays));
  if (f.sort !== 'most_overdue') qs.set('sort', f.sort);
  return qs;
}

/** The page's own query string for these filters ('' when none). */
export function filtersToSearch(f: InboxFilters): string {
  return filterParams(f).toString();
}

/** How many filters narrow the list (the sort is not one). */
export function activeFilterCount(f: InboxFilters): number {
  return [...filterParams({ ...f, sort: 'most_overdue' }).keys()].length;
}

/** GET /api/cases for these filters and page (`after` = nextCursor). */
export function inboxUrl(
  f: InboxFilters,
  after: string | null,
  limit = INBOX_PAGE_SIZE
): string {
  const qs = filterParams(f);
  qs.set('limit', String(limit));
  if (after) qs.set('after', after);
  return `/api/cases?${qs}`;
}

/** One row of GET /api/cases, as the screen uses it. */
export interface InboxRow {
  caseId: string;
  bankCode: string | null;
  bankName: string | null;
  stage: string;
  /** The tracker's status word for word; NULL for a lead or none sent yet. */
  submissionStatus: string | null;
  agentId: string | null;
  coordinatorId: string | null;
  priority: CasePriority;
  dueAt: string | null;
  slaState: InboxSlaState | null;
  customerWaiting: boolean;
  documentsMissing: number;
  bankQueryOpen: boolean;
  lastActivityAt: string | null;
  /** Auth user id; null for the API or the system. */
  lastTouchedBy: string | null;
  openTaskOverdueCount: number;
  submissionRef: string | null;
  /** A lead (130): no submission yet. */
  isLead: boolean;
  contactId: string | null;
  /** 141: the customer the submission tracker sent, else the contact's name. */
  contactName: string | null;
  /** The linked CRM contact's own name. */
  contactOwnName: string | null;
  product: string | null;
  /** AED. */
  amount: number | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface InboxPage {
  rows: InboxRow[];
  nextCursor: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const money = (v: unknown): number | null => {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && v.trim() !== ''
        ? Number(v)
        : NaN;
  return Number.isFinite(n) ? n : null;
};

function parseRow(r: unknown): InboxRow | null {
  if (!isObj(r) || typeof r.caseId !== 'string' || !r.caseId) return null;
  return {
    caseId: r.caseId,
    bankCode: optStr(r.bankCode),
    bankName: optStr(r.bankName),
    stage: optStr(r.stage) ?? '',
    submissionStatus: optStr(r.submissionStatus),
    agentId: optStr(r.agentId),
    coordinatorId: optStr(r.coordinatorId),
    priority:
      oneOf(PRIORITIES, typeof r.priority === 'string' ? r.priority : null) ??
      'normal',
    dueAt: optStr(r.dueAt),
    slaState: oneOf(
      SLA_STATES,
      typeof r.slaState === 'string' ? r.slaState : null
    ),
    customerWaiting: r.customerWaiting === true,
    documentsMissing: count(r.documentsMissing),
    bankQueryOpen: r.bankQueryOpen === true,
    lastActivityAt: optStr(r.lastActivityAt),
    lastTouchedBy: optStr(r.lastTouchedBy),
    openTaskOverdueCount: count(r.openTaskOverdueCount),
    submissionRef: optStr(r.submissionRef),
    isLead: r.isLead === true,
    contactId: optStr(r.contactId),
    contactName: optStr(r.contactName),
    contactOwnName: optStr(r.contactOwnName),
    product: optStr(r.product),
    amount: money(r.amount),
    openedAt: optStr(r.openedAt),
    closedAt: optStr(r.closedAt),
  };
}

/** The inbox response, tolerant of a missing or malformed body. */
export function parseInboxPage(json: unknown): InboxPage {
  if (!isObj(json)) return { rows: [], nextCursor: null };
  const rows = Array.isArray(json.rows)
    ? json.rows.map(parseRow).filter((r): r is InboxRow => r !== null)
    : [];
  return { rows, nextCursor: optStr(json.nextCursor) };
}

/** Appends a next page, one row per case (a row can shift pages). */
export function appendRows(
  current: readonly InboxRow[],
  next: readonly InboxRow[]
): InboxRow[] {
  const seen = new Set(current.map((r) => r.caseId));
  return [...current, ...next.filter((r) => !seen.has(r.caseId))];
}

export interface CaseBankOption {
  code: string;
  name: string;
}

/** GET /api/cases/config/banks -> the bank filter's options; [] on anything odd. */
export function parseBanks(json: unknown): CaseBankOption[] {
  if (!isObj(json) || !Array.isArray(json.banks)) return [];
  return json.banks
    .filter(
      (b): b is { code: string; name?: unknown } =>
        isObj(b) && typeof b.code === 'string' && b.code !== ''
    )
    .map((b) => ({ code: b.code, name: optStr(b.name) ?? b.code }));
}

/**
 * The stage filter's options: the defaults, then any other stage seen in the
 * loaded rows or currently selected, sorted.
 */
export function stageFilterOptions(
  rows: readonly { stage: string }[],
  selected: string | null
): string[] {
  const known = new Set(DEFAULT_STAGES);
  const extra = new Set<string>();
  for (const r of rows) if (r.stage && !known.has(r.stage)) extra.add(r.stage);
  if (selected && !known.has(selected)) extra.add(selected);
  return [...DEFAULT_STAGES, ...[...extra].sort()];
}

/** An amount in AED with 2 decimals; null when unknown. */
export function formatAed(
  amount: number | string | null,
  locale?: string
): string | null {
  if (amount === null) return null;
  if (typeof amount === 'string') {
    // A decimal string goes to Intl as is: Number() would round past 2^53.
    if (!/^-?\d+(?:\.\d+)?$/.test(amount.trim())) return null;
    amount = amount.trim();
  } else if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'AED',
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount as number | `${number}`);
}

/**
 * The contact's own name to show under a case's customer (141), or null
 * when it adds nothing: no name, or the same as the customer shown.
 */
export function contactPersonLine(
  customer: string | null,
  contactOwnName: string | null
): string | null {
  const own = contactOwnName?.trim();
  if (!own) return null;
  const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return customer && norm(customer) === norm(own) ? null : own;
}
