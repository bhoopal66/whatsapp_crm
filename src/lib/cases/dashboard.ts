/**
 * The bank dashboard and decline / withdraw reasons (module 018c,
 * migration 127), each ONE call of a SECURITY DEFINER function on a
 * service-role client with the actor passed as a parameter.
 *
 *   get               bank_ws_dashboard: aggregates over the cases of the
 *                     workspace's bank that the actor may read (admins:
 *                     scope 'all'; everyone else: their own, scope 'own'),
 *                     computed at the given clock. Members of the bank
 *                     workspace only. Counts and amounts, never a case or
 *                     customer identifier. The jsonb is parsed
 *                     defensively: a missing or wrong-typed key becomes a
 *                     safe default, never a throw.
 *   setOutcomeReason  case_outcome_reason_set: once per Declined /
 *                     Withdrawn case, by whoever may write the case.
 *
 * Refusals (an `error.hint` in BANK_DASHBOARD_REFUSALS) throw
 * BankDashboardRefusedError; anything else CaseStoreError (or
 * CaseRefusedError for a case hint).
 */
import { CaseRpc } from './rpc';
import { fail } from './store';

/** 130's case_outcome_reasons_code_check (127's plus NO_RESPONSE); dashboard.test.ts reads 130. */
export const OUTCOME_REASON_CODES = [
  'INCOMPLETE_DOCS',
  'CREDIT_POLICY',
  'INCOME_INSUFFICIENT',
  'KYC_AML',
  'CUSTOMER_WITHDREW',
  'OTHER',
  'NO_RESPONSE',
] as const;
export type OutcomeReasonCode = (typeof OUTCOME_REASON_CODES)[number];
/** 127's REASON_TEXT_TOO_LONG limit. */
export const OUTCOME_REASON_TEXT_CAP = 500;

export const BANK_DASHBOARD_REFUSALS = [
  'BANK_WS_NOT_FOUND',
  'NOT_ALLOWED',
  'NOW_REQUIRED',
  'REASON_INVALID',
  'REASON_TEXT_TOO_LONG',
  'OUTCOME_NOT_DECLINED',
  'REASON_ALREADY_SET',
  // 130: NO_RESPONSE on a case that is not Withdrawn.
  'OUTCOME_REASON',
] as const;
export type BankDashboardRefusal = (typeof BANK_DASHBOARD_REFUSALS)[number];
const REFUSALS = new Set<string>(BANK_DASHBOARD_REFUSALS);

export class BankDashboardRefusedError extends Error {
  override readonly name = 'BankDashboardRefusedError';
  constructor(readonly reason: BankDashboardRefusal) {
    super(`bank dashboard refused: ${reason}`);
  }
}

export type DashboardScope = 'all' | 'own';

export interface BankDashboardData {
  /** 'all' for account admins, 'own' otherwise; every figure is over that case set. */
  scope: DashboardScope;
  totalCases: number;
  casesByStage: Record<string, number>;
  /** Working stages only; an open case's current stage counts up to `now`. */
  avgDaysPerStage: Record<string, { avgDays: number; intervals: number }>;
  /** rate = approved / (approved + declined), NULL when both are 0. */
  approval: {
    approved: number;
    declined: number;
    withdrawn: number;
    rate: number | null;
  };
  declinedReasons: Partial<Record<OutcomeReasonCode, number>>;
  withdrawnReasons: Partial<Record<OutcomeReasonCode, number>>;
  /** Cases with an overdue running SLA timer or an overdue open task, each once. */
  overdueCount: number;
  /** AED as a decimal string, over cases not at a final stage. */
  amountInPipeline: string;
  /** 131: open cases at Interested / Data collection / Review. */
  preSubmission: number;
  /** 131: open cases past pre-submission. */
  withBank: number;
  /** 131: open cases; accounts = amount NULL or 0, financing = amount > 0 (AED decimal string). */
  pipeline: {
    accounts: number;
    financingCases: number;
    financingAmount: string;
  };
  /** 131: rate = submitted / leads (4 dp), NULL with no leads. */
  conversion: { leads: number; submitted: number; rate: number | null };
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const count = (v: unknown): number => num(v) ?? 0;

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v)))
    if (num(n) !== null) out[k] = n as number;
  return out;
}

function reasons(v: unknown): Partial<Record<OutcomeReasonCode, number>> {
  const all = counts(v);
  const out: Partial<Record<OutcomeReasonCode, number>> = {};
  for (const code of OUTCOME_REASON_CODES)
    if (code in all) out[code] = all[code];
  return out;
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const decimal = (v: unknown): string =>
  typeof v === 'string' && DECIMAL.test(v) ? v : '0.00';

/** bank_ws_dashboard's jsonb -> BankDashboardData; never throws. */
export function parseBankDashboard(raw: unknown): BankDashboardData {
  const d = obj(raw);
  const avg: BankDashboardData['avgDaysPerStage'] = {};
  for (const [stage, v] of Object.entries(obj(d.avg_days_per_stage))) {
    const e = obj(v);
    const avgDays = num(e.avg_days);
    if (avgDays !== null)
      avg[stage] = { avgDays, intervals: count(e.intervals) };
  }
  const a = obj(d.approval);
  const p = obj(d.pipeline);
  const cv = obj(d.conversion);
  return {
    scope: d.scope === 'all' ? 'all' : 'own',
    totalCases: count(d.total_cases),
    casesByStage: counts(d.cases_by_stage),
    avgDaysPerStage: avg,
    approval: {
      approved: count(a.approved),
      declined: count(a.declined),
      withdrawn: count(a.withdrawn),
      rate: num(a.rate),
    },
    declinedReasons: reasons(d.declined_reasons),
    withdrawnReasons: reasons(d.withdrawn_reasons),
    overdueCount: count(d.overdue_count),
    amountInPipeline: decimal(d.amount_in_pipeline),
    preSubmission: count(d.pre_submission),
    withBank: count(d.with_bank),
    pipeline: {
      accounts: count(p.accounts),
      financingCases: count(p.financing_cases),
      financingAmount: decimal(p.financing_amount),
    },
    conversion: {
      leads: count(cv.leads),
      submitted: count(cv.submitted),
      rate: num(cv.rate),
    },
  };
}

export class BankDashboard extends CaseRpc {
  protected override async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
        throw new BankDashboardRefusedError(error.hint as BankDashboardRefusal);
      fail(fn, error);
    }
    return data as unknown;
  }

  async get(
    actor: string,
    bankWsId: string,
    now?: Date
  ): Promise<BankDashboardData> {
    const at = now ?? this.clock();
    if (Number.isNaN(at.getTime()))
      throw new BankDashboardRefusedError('NOW_REQUIRED');
    return parseBankDashboard(
      await this.rpc('bank_ws_dashboard', {
        p_actor: actor,
        p_bank_ws: bankWsId,
        p_now: at.toISOString(),
      })
    );
  }

  /** Once per Declined / Withdrawn case; `text` optional, up to 500 characters. */
  async setOutcomeReason(
    actor: string,
    caseId: string,
    code: OutcomeReasonCode,
    text: string | null = null
  ): Promise<void> {
    await this.rpc('case_outcome_reason_set', {
      p_actor: actor,
      p_case: caseId,
      p_code: code,
      p_text: text,
    });
  }
}
