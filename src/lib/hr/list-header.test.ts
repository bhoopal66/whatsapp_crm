import { describe, expect, it } from 'vitest';

import {
  HR_LIST_DEFAULTS,
  activeHrQuick,
  applyHrQuick,
  clearHrChip,
  hrActiveChips,
  hrQuickCounts,
  hrQuickFilters,
  parseHrListParams,
  writeHrListParams,
  type HrListFilters,
  type HrTab,
} from './list-filters';
import type { HrCounts } from './types';

const f = (over: Partial<HrListFilters> = {}): HrListFilters => ({
  ...HR_LIST_DEFAULTS,
  tab: 'recruiter',
  ...over,
});

const COUNTS: HrCounts = {
  recruiter: { all: 6, unread: 3, mine: 0, urgent: 1 },
  dept: { all: 11, unread: 2, mine: 4, urgent: 2 },
  unsorted: 5,
};

describe('HR quick filters', () => {
  it('Unread is the reply state reply_due', () => {
    const next = applyHrQuick(f(), 'unread');
    expect(next.reply).toBe('reply_due');
    expect(activeHrQuick(next)).toBe('unread');
    expect(activeHrQuick(f({ reply: 'waiting' }))).toBe('all');
    expect(activeHrQuick(f({ reply: 'reply_due' }))).toBe('unread');
  });

  it('one at a time, and All clears the three it owns', () => {
    const mine = applyHrQuick(applyHrQuick(f(), 'urgent'), 'mine');
    expect(mine).toMatchObject({ mine: true, urgent: false });
    const urgent = applyHrQuick(applyHrQuick(f(), 'unread'), 'urgent');
    expect(urgent).toMatchObject({ urgent: true, reply: null });
    const all = applyHrQuick(
      f({ mine: true, reply: 'reply_due', stage: 'cv_review', closed: true }),
      'all'
    );
    expect(all).toMatchObject({
      mine: false,
      urgent: false,
      reply: null,
      stage: 'cv_review',
      closed: true,
    });
    // A dropdown reply state other than reply_due is not the quick filter's.
    expect(applyHrQuick(f({ reply: 'new' }), 'mine').reply).toBe('new');
  });

  it('Not sorted offers All and Mine only, never an HR-row filter', () => {
    expect(hrQuickFilters('unsorted')).toEqual(['all', 'mine']);
    expect(hrQuickFilters('dept')).toEqual(['all', 'unread', 'mine', 'urgent']);
    const u = applyHrQuick(f({ tab: 'unsorted' }), 'unread');
    expect(u).toMatchObject({ reply: null, urgent: false });
  });

  it('numbers per inbox from hr_counts()', () => {
    expect(hrQuickCounts(COUNTS, 'recruiter')).toEqual(COUNTS.recruiter);
    expect(hrQuickCounts(COUNTS, 'dept')).toEqual(COUNTS.dept);
    expect(hrQuickCounts(COUNTS, 'unsorted')).toEqual({ all: 5 });
    expect(hrQuickCounts(null, 'dept')).toEqual({});
  });
});

describe('HR active filter chips', () => {
  it('lists what is on and clears one', () => {
    const on = f({
      tab: 'dept',
      topic: 'payroll',
      topicGroup: 'letters',
      reply: 'waiting',
      mine: true,
      closed: true,
    });
    expect(hrActiveChips(on).map((c) => c.key)).toEqual([
      'mine',
      'topicGroup',
      'topic',
      'reply',
      'closed',
    ]);
    expect(clearHrChip(on, 'topic')).toEqual({ ...on, topic: null });
    expect(clearHrChip(on, 'closed')).toEqual({ ...on, closed: false });
    expect(hrActiveChips(f())).toEqual([]);
  });
});

describe('HR header filters round-trip through the URL', () => {
  const cases: [HrTab, Partial<HrListFilters>][] = [
    ['recruiter', { stage: 'hr_interview', reply: 'reply_due', urgent: true }],
    ['dept', { topic: 'payroll', topicGroup: 'letters', mine: true }],
    ['unsorted', { mine: true, closed: true }],
  ];
  it.each(cases)('%s', (tab, over) => {
    const filters = f({ tab, ...over });
    const params = writeHrListParams(new URLSearchParams(), filters, tab);
    expect(params.has('hrTab')).toBe(false);
    expect(parseHrListParams(params, tab)).toEqual(filters);
  });
});
