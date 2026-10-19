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
});

const LABELS = {
  INCOMPLETE_DOCS: 'Incomplete documents',
  CREDIT_POLICY: 'Credit policy',
  INCOME_INSUFFICIENT: 'Income too low',
  KYC_AML: 'KYC / AML',
  CUSTOMER_WITHDREW: 'Customer withdrew',
  OTHER: 'Other',
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
  it('puts open cases first, each half newest first', () => {
    const split = splitCases([
      bankCase('a', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'),
      bankCase('b', '2026-10-02T00:00:00Z'),
      bankCase('c', '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z'),
      bankCase('d', null),
      bankCase('e', '2026-10-08T00:00:00Z'),
    ]);
    expect(split.open.map((c) => c.caseId)).toEqual(['e', 'b', 'd']);
    expect(split.closed.map((c) => c.caseId)).toEqual(['c', 'a']);
    expect(visibleCases(split, 'all').map((c) => c.caseId)).toEqual([
      'e',
      'b',
      'd',
      'c',
      'a',
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
    });
    const empty = parseDashboard({ dashboard: { amountInPipeline: '1e9' } });
    expect(empty?.scope).toBe('own');
    expect(empty?.approval.rate).toBeNull();
    expect(empty?.amountInPipeline).toBe('0.00');
    expect(parseDashboard({})).toBeNull();
    expect(parseDashboard(null)).toBeNull();
  });
});
