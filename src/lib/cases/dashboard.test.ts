// The bank dashboard and outcome reasons on a fake supabase-js client:
// the args sent, the defensive jsonb parse, and hints ->
// BankDashboardRefusedError. The SQL is 127's (verify-bank-dashboard.sql).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  BANK_DASHBOARD_REFUSALS,
  BankDashboard,
  BankDashboardRefusedError,
  OUTCOME_REASON_CODES,
  parseBankDashboard,
} from './dashboard';
import { CaseStoreError } from './store';

type Args = Record<string, unknown>;
type Answer = {
  data?: unknown;
  error?: { message: string; hint?: string; code?: string };
};

class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  constructor(readonly script: Record<string, Answer> = {}) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const a = this.script[fn];
    if (!a) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }
  get client() {
    return this as unknown as SupabaseClient;
  }
}

const WS = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const CASE = '77777777-7777-4777-8777-777777777777';
const T0 = new Date('2026-10-19T08:00:00.000Z');

const GOOD = {
  scope: 'all',
  total_cases: 5,
  cases_by_stage: { Submitted: 2, Approved: 2, Declined: 1 },
  avg_days_per_stage: { Submitted: { avg_days: 1.5, intervals: 4 } },
  approval: { approved: 2, declined: 1, withdrawn: 0, rate: 0.6667 },
  declined_reasons: { CREDIT_POLICY: 1 },
  withdrawn_reasons: {},
  overdue_count: 1,
  amount_in_pipeline: '250000.00',
  pre_submission: 2,
  with_bank: 1,
  pipeline: { accounts: 1, financing_cases: 2, financing_amount: '250000.00' },
  conversion: { leads: 4, submitted: 3, rate: 0.75 },
};

const EMPTY = {
  scope: 'own',
  totalCases: 0,
  casesByStage: {},
  avgDaysPerStage: {},
  approval: { approved: 0, declined: 0, withdrawn: 0, rate: null },
  declinedReasons: {},
  withdrawnReasons: {},
  overdueCount: 0,
  amountInPipeline: '0.00',
  preSubmission: 0,
  withBank: 0,
  pipeline: { accounts: 0, financingCases: 0, financingAmount: '0.00' },
  conversion: { leads: 0, submitted: 0, rate: null },
};

describe('parseBankDashboard', () => {
  it('a good payload', () => {
    expect(parseBankDashboard(GOOD)).toEqual({
      scope: 'all',
      totalCases: 5,
      casesByStage: { Submitted: 2, Approved: 2, Declined: 1 },
      avgDaysPerStage: { Submitted: { avgDays: 1.5, intervals: 4 } },
      approval: { approved: 2, declined: 1, withdrawn: 0, rate: 0.6667 },
      declinedReasons: { CREDIT_POLICY: 1 },
      withdrawnReasons: {},
      overdueCount: 1,
      amountInPipeline: '250000.00',
      preSubmission: 2,
      withBank: 1,
      pipeline: {
        accounts: 1,
        financingCases: 2,
        financingAmount: '250000.00',
      },
      conversion: { leads: 4, submitted: 3, rate: 0.75 },
    });
  });

  it('131 keys: wrong types become defaults; money stays an exact string', () => {
    const p = parseBankDashboard({
      pre_submission: '2',
      with_bank: null,
      pipeline: {
        accounts: 3,
        financing_cases: 'x',
        financing_amount: 9007199254740993.5,
      },
      conversion: { leads: 2, submitted: 0, rate: '0.5' },
    });
    expect(p.preSubmission).toBe(0);
    expect(p.withBank).toBe(0);
    expect(p.pipeline).toEqual({
      accounts: 3,
      financingCases: 0,
      financingAmount: '0.00',
    });
    expect(p.conversion).toEqual({ leads: 2, submitted: 0, rate: null });
    expect(
      parseBankDashboard({
        pipeline: { financing_amount: '9007199254740993.25' },
      }).pipeline.financingAmount
    ).toBe('9007199254740993.25');
    expect(parseBankDashboard({ pipeline: [1] }).pipeline).toEqual(
      EMPTY.pipeline
    );
  });

  it('missing keys and non-objects become safe defaults, never a throw', () => {
    expect(parseBankDashboard({})).toEqual(EMPTY);
    expect(parseBankDashboard(null)).toEqual(EMPTY);
    expect(parseBankDashboard('nope')).toEqual(EMPTY);
    expect(parseBankDashboard([1, 2])).toEqual(EMPTY);
    const partial: Record<string, unknown> = { ...GOOD };
    delete partial.approval;
    delete partial.avg_days_per_stage;
    const p = parseBankDashboard(partial);
    expect(p.approval).toEqual(EMPTY.approval);
    expect(p.avgDaysPerStage).toEqual({});
    expect(p.totalCases).toBe(5);
  });

  it('wrong types become defaults; a bad entry is dropped, the rest kept', () => {
    expect(
      parseBankDashboard({
        scope: 'everything',
        total_cases: '5',
        cases_by_stage: { Submitted: 'two', Approved: 2 },
        avg_days_per_stage: {
          Submitted: 3,
          Review: { avg_days: 'x' },
          Bank: { avg_days: 2 },
        },
        approval: {
          approved: null,
          declined: 1,
          withdrawn: Infinity,
          rate: '0.5',
        },
        declined_reasons: { CREDIT_POLICY: 2, MADE_UP: 4, KYC_AML: 'x' },
        withdrawn_reasons: [3],
        overdue_count: NaN,
        amount_in_pipeline: 250000,
      })
    ).toEqual({
      scope: 'own',
      totalCases: 0,
      casesByStage: { Approved: 2 },
      avgDaysPerStage: { Bank: { avgDays: 2, intervals: 0 } },
      approval: { approved: 0, declined: 1, withdrawn: 0, rate: null },
      declinedReasons: { CREDIT_POLICY: 2 },
      withdrawnReasons: {},
      overdueCount: 0,
      amountInPipeline: '0.00',
      preSubmission: 0,
      withBank: 0,
      pipeline: EMPTY.pipeline,
      conversion: EMPTY.conversion,
    });
    expect(
      parseBankDashboard({ amount_in_pipeline: '12; drop' }).amountInPipeline
    ).toBe('0.00');
  });

  it('a null rate (no approved or declined case) stays null', () => {
    const p = parseBankDashboard({
      ...GOOD,
      approval: { approved: 0, declined: 0, withdrawn: 3, rate: null },
    });
    expect(p.approval).toEqual({
      approved: 0,
      declined: 0,
      withdrawn: 3,
      rate: null,
    });
  });
});

describe('BankDashboard', () => {
  it('get sends the actor, workspace and clock (or the given now)', async () => {
    const db = new FakeDb({ bank_ws_dashboard: { data: GOOD } });
    const d = new BankDashboard(db.client, () => T0);
    expect((await d.get(ACTOR, WS)).totalCases).toBe(5);
    const at = new Date('2026-10-01T00:00:00.000Z');
    await d.get(ACTOR, WS, at);
    expect(db.calls.map((c) => c.args)).toEqual([
      { p_actor: ACTOR, p_bank_ws: WS, p_now: T0.toISOString() },
      { p_actor: ACTOR, p_bank_ws: WS, p_now: at.toISOString() },
    ]);
  });

  it('get refuses an invalid clock before any call', async () => {
    const db = new FakeDb({});
    const d = new BankDashboard(db.client, () => T0);
    await expect(d.get(ACTOR, WS, new Date('x'))).rejects.toMatchObject({
      reason: 'NOW_REQUIRED',
    });
    expect(db.calls).toEqual([]);
  });

  it('setOutcomeReason sends the code and text (NULL when absent)', async () => {
    const db = new FakeDb({ case_outcome_reason_set: { data: null } });
    const d = new BankDashboard(db.client, () => T0);
    await d.setOutcomeReason(ACTOR, CASE, 'KYC_AML', 'docs failed');
    await d.setOutcomeReason(ACTOR, CASE, 'OTHER');
    expect(db.calls).toEqual([
      {
        fn: 'case_outcome_reason_set',
        args: {
          p_actor: ACTOR,
          p_case: CASE,
          p_code: 'KYC_AML',
          p_text: 'docs failed',
        },
      },
      {
        fn: 'case_outcome_reason_set',
        args: { p_actor: ACTOR, p_case: CASE, p_code: 'OTHER', p_text: null },
      },
    ]);
  });

  it.each(BANK_DASHBOARD_REFUSALS)(
    'hint %s -> BankDashboardRefusedError',
    async (hint) => {
      const db = new FakeDb({
        bank_ws_dashboard: { error: { message: 'x', code: 'P0001', hint } },
        case_outcome_reason_set: {
          error: { message: 'x', code: 'P0001', hint },
        },
      });
      const d = new BankDashboard(db.client, () => T0);
      for (const p of [
        d.get(ACTOR, WS),
        d.setOutcomeReason(ACTOR, CASE, 'OTHER'),
      ]) {
        const err = await p.catch((e) => e);
        expect(err).toBeInstanceOf(BankDashboardRefusedError);
        expect(err.reason).toBe(hint);
      }
    }
  );

  it('any other error is a CaseStoreError', async () => {
    const db = new FakeDb({
      bank_ws_dashboard: { error: { message: 'boom', code: '57014' } },
    });
    const err = await new BankDashboard(db.client)
      .get(ACTOR, WS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CaseStoreError);
    expect(err).toMatchObject({ fn: 'bank_ws_dashboard', code: '57014' });
  });
});

describe('dashboard mirrors match migration 127', () => {
  const SQL = readFileSync(
    join(process.cwd(), 'supabase/migrations/127_bank_dashboard.sql'),
    'utf8'
  );

  it('OUTCOME_REASON_CODES are the codes case_outcome_reasons_code_check allows (130)', () => {
    const m =
      /case_outcome_reasons_code_check\s+CHECK \(reason_code IN \(([^)]*)\)/.exec(
        readFileSync(
          join(process.cwd(), 'supabase/migrations/130_case_leads.sql'),
          'utf8'
        )
      );
    expect(m).not.toBeNull();
    const codes = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(new Set(codes)).toEqual(new Set(OUTCOME_REASON_CODES));
  });

  it("BANK_DASHBOARD_REFUSALS are exactly the HINTs 127 raises, plus 130's OUTCOME_REASON", () => {
    const hints = [...SQL.matchAll(/HINT = '([A-Z_]+)'/g)].map((m) => m[1]);
    const sql130 = readFileSync(
      join(process.cwd(), 'supabase/migrations/130_case_leads.sql'),
      'utf8'
    );
    expect(sql130).toContain("HINT = 'OUTCOME_REASON'");
    expect(new Set(BANK_DASHBOARD_REFUSALS)).toEqual(
      new Set([...hints, 'OUTCOME_REASON'])
    );
  });
});
