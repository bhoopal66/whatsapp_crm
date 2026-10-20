import { describe, expect, it } from 'vitest';

import { OUTCOME_REASON_CODES } from '@/lib/cases/dashboard';
import { DEFAULT_STAGES } from '@/lib/cases/ui';

import {
  avgDaysSeries,
  parseDashboard,
  percent,
  REASON_CODES,
  reasonSeries,
  splitCases,
  stageSeries,
  visibleCases,
} from './dashboard-ui';
import { parseBankPage, type BankCase } from './ui';

const bankCase = (
  id: string,
  openedAt: string | null,
  closedAt: string | null = null
): BankCase => ({
  caseId: id,
  stage: 'Submitted',
  product: null,
  agentId: null,
  coordinatorId: null,
  openedAt,
  closedAt,
  contactId: null,
  contactName: null,
  slaState: null,
  nextDueAt: null,
  isLead: false,
});

const LABELS = {
  INCOMPLETE_DOCS: 'Incomplete documents',
  CREDIT_POLICY: 'Credit policy',
  INCOME_INSUFFICIENT: 'Income too low',
  KYC_AML: 'KYC / AML',
  CUSTOMER_WITHDREW: 'Customer withdrew',
  OTHER: 'Other',
  NO_RESPONSE: 'No response',
};

describe('percent', () => {
  it('shows one decimal', () => {
    expect(percent(0.4567, 'en')).toBe('45.7%');
    expect(percent(1, 'en')).toBe('100.0%');
    expect(percent(0, 'en')).toBe('0.0%');
  });
  it('is a dash when there is no rate', () => {
    expect(percent(null, 'en')).toBe('—');
    expect(percent(Number.NaN, 'en')).toBe('—');
  });
});

describe('stageSeries', () => {
  it('follows the stage order and appends unknown stages alphabetically', () => {
    expect(
      stageSeries(
        { Zeta: 1, Approved: 2, Alpha: 4, Submitted: 3, Declined: 0 },
        DEFAULT_STAGES
      )
    ).toEqual([
      { stage: 'Submitted', count: 3 },
      { stage: 'Approved', count: 2 },
      { stage: 'Alpha', count: 4 },
      { stage: 'Zeta', count: 1 },
    ]);
  });
  it('is empty with no cases', () => {
    expect(stageSeries({}, DEFAULT_STAGES)).toEqual([]);
  });
});

describe('avgDaysSeries', () => {
  it('rounds to one decimal, keeps intervals, drops empty stages', () => {
    expect(
      avgDaysSeries(
        {
          'Under review': { avgDays: 3.456, intervals: 4 },
          Submitted: { avgDays: 1.04, intervals: 2 },
          Custom: { avgDays: 9, intervals: 1 },
          'Query raised': { avgDays: 0, intervals: 0 },
        },
        DEFAULT_STAGES
      )
    ).toEqual([
      { stage: 'Submitted', avgDays: 1, intervals: 2 },
      { stage: 'Under review', avgDays: 3.5, intervals: 4 },
      { stage: 'Custom', avgDays: 9, intervals: 1 },
    ]);
  });
});

describe('reasonSeries', () => {
  it('labels reasons in code order and drops zeros', () => {
    expect(
      reasonSeries({ OTHER: 1, KYC_AML: 2, CREDIT_POLICY: 0 }, LABELS)
    ).toEqual([
      { code: 'KYC_AML', label: 'KYC / AML', count: 2 },
      { code: 'OTHER', label: 'Other', count: 1 },
    ]);
  });
  it('restates 127 reason codes exactly', () => {
    expect([...REASON_CODES]).toEqual([...OUTCOME_REASON_CODES]);
  });
});

describe('splitCases', () => {
  // 131: bank_ws_cases orders by SLA urgency; the UI keeps that order.
  it("puts open cases first, each half in the server's order", () => {
    const split = splitCases([
      bankCase('a', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'),
      bankCase('b', '2026-10-02T00:00:00Z'),
      bankCase('c', '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z'),
      bankCase('d', null),
      bankCase('e', '2026-10-08T00:00:00Z'),
    ]);
    expect(split.open.map((c) => c.caseId)).toEqual(['b', 'd', 'e']);
    expect(split.closed.map((c) => c.caseId)).toEqual(['a', 'c']);
    expect(visibleCases(split, 'all').map((c) => c.caseId)).toEqual([
      'b',
      'd',
      'e',
      'a',
      'c',
    ]);
    expect(visibleCases(split, 'open')).toBe(split.open);
    expect(visibleCases(split, 'closed')).toBe(split.closed);
  });
  it('reads openedAt from the bank page', () => {
    expect(
      parseBankPage({
        cases: [{ caseId: 'x', openedAt: '2026-10-01T00:00:00.000Z' }],
      }).cases[0].openedAt
    ).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('parseDashboard', () => {
  it('reads the route body and defaults what is missing or wrong', () => {
    const d = parseDashboard({
      dashboard: {
        scope: 'all',
        totalCases: 5,
        casesByStage: { Submitted: 3, Approved: 'x' },
        avgDaysPerStage: { Submitted: { avgDays: 2, intervals: 3 }, Bad: 1 },
        approval: { approved: 2, declined: 1, withdrawn: 1, rate: 0.6667 },
        declinedReasons: { KYC_AML: 1, NOPE: 4 },
        withdrawnReasons: {},
        overdueCount: 1,
        amountInPipeline: '1200.50',
      },
    });
    expect(d).toEqual({
      scope: 'all',
      totalCases: 5,
      casesByStage: { Submitted: 3, Approved: 0 },
      avgDaysPerStage: { Submitted: { avgDays: 2, intervals: 3 } },
      approval: { approved: 2, declined: 1, withdrawn: 1, rate: 0.6667 },
      declinedReasons: { KYC_AML: 1 },
      withdrawnReasons: {},
      overdueCount: 1,
      amountInPipeline: '1200.50',
      preSubmission: 0,
      withBank: 0,
      pipeline: { accounts: 0, financingCases: 0, financingAmount: '0.00' },
      conversion: { leads: 0, submitted: 0, rate: null },
    });
    const empty = parseDashboard({ dashboard: { amountInPipeline: '1e9' } });
    expect(empty?.scope).toBe('own');
    expect(empty?.approval.rate).toBeNull();
    expect(empty?.amountInPipeline).toBe('0.00');
    expect(parseDashboard({})).toBeNull();
    expect(parseDashboard(null)).toBeNull();
  });
});

describe('parseDashboard: 131 keys', () => {
  it('reads the new figures; money stays an exact string', () => {
    const d = parseDashboard({
      dashboard: {
        preSubmission: 2,
        withBank: 3,
        pipeline: {
          accounts: 1,
          financingCases: 4,
          financingAmount: '9007199254740993.25',
        },
        conversion: { leads: 5, submitted: 2, rate: 0.4 },
      },
    });
    expect(d?.preSubmission).toBe(2);
    expect(d?.withBank).toBe(3);
    expect(d?.pipeline).toEqual({
      accounts: 1,
      financingCases: 4,
      financingAmount: '9007199254740993.25',
    });
    expect(d?.conversion).toEqual({ leads: 5, submitted: 2, rate: 0.4 });
  });
  it('bad or missing keys become safe defaults', () => {
    const d = parseDashboard({
      dashboard: { pipeline: { financingAmount: 12.5 }, conversion: 'x' },
    });
    expect(d?.pipeline).toEqual({
      accounts: 0,
      financingCases: 0,
      financingAmount: '0.00',
    });
    expect(d?.conversion).toEqual({ leads: 0, submitted: 0, rate: null });
  });
});
