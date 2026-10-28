import { describe, expect, it } from 'vitest';

import type { InboxRow } from '@/lib/cases/ui';
import { casesHref, formatFigure, summarizeCases } from './cases';

let seq = 0;
function row(over: Partial<InboxRow> = {}): InboxRow {
  seq++;
  return {
    caseId: `c${seq}`,
    bankCode: 'ADCB',
    bankName: 'ADCB',
    stage: 'Submitted',
    submissionStatus: null,
    agentId: null,
    coordinatorId: null,
    priority: 'normal',
    dueAt: null,
    slaState: 'on_track',
    customerWaiting: false,
    documentsMissing: 0,
    bankQueryOpen: false,
    lastActivityAt: null,
    lastTouchedBy: null,
    openTaskOverdueCount: 0,
    submissionRef: null,
    isLead: false,
    contactId: null,
    contactName: null,
    contactOwnName: null,
    product: null,
    amount: null,
    openedAt: null,
    closedAt: null,
    ...over,
  };
}

describe('summarizeCases', () => {
  it('counts leads apart from open, and every flag over all rows', () => {
    const s = summarizeCases(
      [
        row({ slaState: 'overdue', customerWaiting: true }),
        row({ slaState: 'due_soon', documentsMissing: 2 }),
        row({ bankQueryOpen: true, documentsMissing: 1 }),
        row({ isLead: true, stage: 'Interested', slaState: 'overdue' }),
      ],
      false
    );
    expect(s.open).toEqual({ count: 3, atLeast: false });
    expect(s.leads).toEqual({ count: 1, atLeast: false });
    expect(s.overdue.count).toBe(2);
    expect(s.dueSoon.count).toBe(1);
    expect(s.customerWaiting.count).toBe(1);
    expect(s.documentsMissing.count).toBe(2);
    expect(s.bankQueries.count).toBe(1);
  });

  it('reads counts as floors when the list was cut, overdue only if all were', () => {
    const cut = summarizeCases(
      [row({ slaState: 'overdue' }), row({ slaState: 'on_track' })],
      true
    );
    expect(cut.open.atLeast).toBe(true);
    expect(cut.dueSoon.atLeast).toBe(true);
    expect(cut.overdue).toEqual({ count: 1, atLeast: false });
    const allOverdue = summarizeCases([row({ slaState: 'overdue' })], true);
    expect(allOverdue.overdue).toEqual({ count: 1, atLeast: true });
  });

  it('keeps the server order for the five most urgent', () => {
    const rows = Array.from({ length: 7 }, () => row());
    expect(summarizeCases(rows, false).urgent.map((r) => r.caseId)).toEqual(
      rows.slice(0, 5).map((r) => r.caseId)
    );
  });

  it('orders stages by the module order, a bank stage last, with shares', () => {
    const s = summarizeCases(
      [
        row({ stage: 'Approved' }),
        row({ stage: 'Bank special' }),
        row({ stage: 'Submitted' }),
        row({ stage: 'Submitted' }),
        row({ stage: 'Interested', isLead: true }),
      ],
      false
    );
    expect(s.byStage).toEqual([
      { stage: 'Interested', count: 1, share: 0.5 },
      { stage: 'Submitted', count: 2, share: 1 },
      { stage: 'Approved', count: 1, share: 0.5 },
      { stage: 'Bank special', count: 1, share: 0.5 },
    ]);
  });

  it('is all zeros with no rows', () => {
    const s = summarizeCases([], false);
    expect(s.open.count).toBe(0);
    expect(s.byStage).toEqual([]);
    expect(s.urgent).toEqual([]);
  });
});

describe('formatFigure', () => {
  it('adds a plus to a floor', () => {
    expect(formatFigure({ count: 200, atLeast: true })).toBe('200+');
    expect(formatFigure({ count: 3, atLeast: false })).toBe('3');
  });
});

describe('casesHref', () => {
  it('uses the inbox URL parameters', () => {
    expect(casesHref()).toBe('/cases');
    expect(casesHref({ slaState: 'overdue' })).toBe('/cases?sla_state=overdue');
    expect(casesHref({ slaState: 'due_soon' })).toBe(
      '/cases?sla_state=due_soon'
    );
    expect(casesHref({ customerWaiting: true })).toBe(
      '/cases?customer_waiting=true'
    );
    expect(casesHref({ documentsMissing: true })).toBe(
      '/cases?documents_missing=true'
    );
    expect(casesHref({ bankQueryOpen: true })).toBe(
      '/cases?bank_query_open=true'
    );
  });
});
