/**
 * The coordinator inbox (module 018c, migration 125): ONE call of the
 * SECURITY DEFINER `case_inbox`, on a service-role client. Postgres decides
 * visibility (case_role, set-wise, in the given account); a pure read with
 * no audit row (it lists case records, not conversations).
 *
 * ACTIVE WORKSPACE: the route passes the caller's ACTIVE account; one login
 * holds profiles in several workspaces.
 *
 * Filters are typed and checked here too (FILTER_INVALID before any call),
 * and only the known keys are mapped to their SQL names: an unknown key is
 * never sent. Pagination is keyset: `nextCursor` (opaque) is set when the
 * page is full; pass it back as `after` with the same filters. A cursor
 * carries its clock, so with `after` and no `now` the cursor's clock is used
 * (125 refuses a cursor from another clock).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SlaState } from './sla';
import { CaseStoreError, date, rows, str } from './store';
import { PRIORITIES, type CasePriority } from './types';

export type CaseInboxSort = 'most_overdue' | 'due_soonest' | 'stalest';

export interface CaseInboxFilters {
  bank?: string;
  stage?: string;
  /** An agent's user id. */
  agent?: string;
  priority?: CasePriority;
  slaState?: SlaState;
  customerWaiting?: boolean;
  documentsMissing?: boolean;
  bankQueryOpen?: boolean;
  /** Whole days, 1..3650: last activity before now - N days. */
  noActivityDays?: number;
  includeClosed?: boolean;
  sort?: CaseInboxSort;
}

export interface CaseInboxRow {
  caseId: string;
  bankCode: string | null;
  stage: string;
  agentId: string;
  coordinatorId: string | null;
  priority: CasePriority;
  dueAt: Date | null;
  slaState: SlaState | null;
  /** Minutes the worst running SLA timer is past due (0: none), then the overdue open tasks. */
  overdueRank: { slaOverdueMinutes: number; overdueTasks: number };
  customerWaiting: boolean;
  documentsMissing: number;
  bankQueryOpen: boolean;
  lastActivityAt: Date;
  lastTouchedBy: string | null;
  openTaskOverdueCount: number;
  submissionRef: string | null;
  /**
   * A lead (130): a case with no submission group yet. 130's case_inbox
   * returns no group id, but it LEFT JOINs submission_groups, whose
   * submission_ref is NOT NULL (115), so a NULL ref is exactly a lead.
   */
  isLead: boolean;
  contactId: string | null;
  contactName: string | null;
  bankName: string | null;
  product: string | null;
  /** AED as a decimal string; NULL until the submission sends it. */
  amount: string | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface CaseInboxPage {
  rows: CaseInboxRow[];
  nextCursor: string | null;
}

export type CaseInboxRefusal =
  | 'NOT_ALLOWED'
  | 'FILTER_INVALID'
  | 'CURSOR_INVALID'
  | 'LIMIT_INVALID'
  | 'NOW_REQUIRED';
const REFUSALS = new Set<string>([
  'NOT_ALLOWED',
  'FILTER_INVALID',
  'CURSOR_INVALID',
  'LIMIT_INVALID',
  'NOW_REQUIRED',
]);

export class CaseInboxRefusedError extends Error {
  override readonly name = 'CaseInboxRefusedError';
  constructor(readonly reason: CaseInboxRefusal) {
    super(`case inbox refused: ${reason}`);
  }
}

/** 125 caps a page here. */
export const INBOX_MAX_LIMIT = 200;
export const INBOX_DEFAULT_LIMIT = 50;

const SORTS: readonly string[] = ['most_overdue', 'due_soonest', 'stalest'];
const SLA_STATES: readonly string[] = ['on_track', 'due_soon', 'overdue'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Check = (v: unknown) => boolean;
const text: Check = (v) =>
  typeof v === 'string' && v.trim() !== '' && v.length <= 200;
const bool: Check = (v) => typeof v === 'boolean';
const oneOf =
  (list: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && list.includes(v);

/** camelCase key -> 125's key and the value check. */
const FILTERS: Record<keyof CaseInboxFilters, [string, Check]> = {
  bank: ['bank', text],
  stage: ['stage', text],
  agent: ['agent', (v) => typeof v === 'string' && UUID.test(v)],
  priority: ['priority', oneOf(PRIORITIES)],
  slaState: ['sla_state', oneOf(SLA_STATES)],
  customerWaiting: ['customer_waiting', bool],
  documentsMissing: ['documents_missing', bool],
  bankQueryOpen: ['bank_query_open', bool],
  noActivityDays: [
    'no_activity_days',
    (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  ],
  includeClosed: ['include_closed', bool],
  sort: ['sort', oneOf(SORTS)],
};

/** The SQL filter object: known keys only, every value checked. */
export function inboxSqlFilters(
  filters: CaseInboxFilters
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined) continue;
    const spec = FILTERS[k as keyof CaseInboxFilters];
    if (!spec || !spec[1](v)) throw new CaseInboxRefusedError('FILTER_INVALID');
    out[spec[0]] = v;
  }
  return out;
}

function toRow(r: Record<string, unknown>): CaseInboxRow {
  const rank = Array.isArray(r.overdue_rank) ? r.overdue_rank : [];
  return {
    caseId: String(r.case_id),
    bankCode: str(r.bank_code),
    stage: String(r.stage),
    agentId: String(r.agent_id),
    coordinatorId: str(r.coordinator_id),
    priority: String(r.priority) as CasePriority,
    dueAt: date(r.due_at),
    slaState: str(r.sla_state) as SlaState | null,
    overdueRank: {
      slaOverdueMinutes: Number(rank[0] ?? 0),
      overdueTasks: Number(rank[1] ?? 0),
    },
    customerWaiting: r.customer_waiting === true,
    documentsMissing: Number(r.documents_missing ?? 0),
    bankQueryOpen: r.bank_query_open === true,
    lastActivityAt: date(r.last_activity_at)!,
    lastTouchedBy: str(r.last_touched_by),
    openTaskOverdueCount: Number(r.open_task_overdue_count ?? 0),
    submissionRef: str(r.submission_ref),
    isLead: str(r.submission_ref) === null,
    contactId: str(r.contact_id),
    contactName: str(r.contact_name),
    bankName: str(r.bank_name),
    product: str(r.product),
    amount: str(r.amount),
    openedAt: date(r.opened_at)!,
    closedAt: date(r.closed_at),
  };
}

export class CaseInbox {
  constructor(
    private readonly db: SupabaseClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async list(
    actor: string,
    accountId: string,
    filters: CaseInboxFilters = {},
    opts: { now?: Date; limit?: number; after?: string | null } = {}
  ): Promise<CaseInboxPage> {
    const sqlFilters = inboxSqlFilters(filters);
    const limit = opts.limit ?? INBOX_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1)
      throw new CaseInboxRefusedError('LIMIT_INVALID');
    // A cursor carries 125's own clock text; it is passed back verbatim
    // (a Date round trip would drop microseconds and fail 125's check).
    let cursorNow: string | null = null;
    if (opts.after != null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.after);
      } catch {
        throw new CaseInboxRefusedError('CURSOR_INVALID');
      }
      const n =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).now
          : undefined;
      if (typeof n !== 'string' || Number.isNaN(new Date(n).getTime()))
        throw new CaseInboxRefusedError('CURSOR_INVALID');
      cursorNow = n;
    }
    if (opts.now !== undefined && Number.isNaN(opts.now.getTime()))
      throw new CaseInboxRefusedError('NOW_REQUIRED');
    const { data, error } = await this.db.rpc('case_inbox', {
      p_actor: actor,
      p_account: accountId,
      p_filters: sqlFilters,
      p_now: opts.now?.toISOString() ?? cursorNow ?? this.clock().toISOString(),
      p_limit: limit,
      p_after: opts.after ?? null,
    });
    if (error) {
      if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
        throw new CaseInboxRefusedError(error.hint as CaseInboxRefusal);
      throw new CaseStoreError('case_inbox', error.code ?? null);
    }
    const raw = rows(data);
    const full =
      raw.length > 0 && raw.length === Math.min(limit, INBOX_MAX_LIMIT);
    return {
      rows: raw.map(toRow),
      nextCursor: full ? str(raw[raw.length - 1].cursor) : null,
    };
  }
}
