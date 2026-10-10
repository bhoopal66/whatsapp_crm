import { describe, expect, it } from 'vitest';

import {
  clientReadiness,
  isKbEntryId,
  isKbWorkbookName,
  isUnusableApprovalError,
  kbEntryMatches,
  parseKbEntryPatch,
  summarizeKb,
} from './requests';

describe('parseKbEntryPatch', () => {
  it('trims strings and nulls blank optional text', () => {
    const r = parseKbEntryPatch({
      version: 4,
      question: '  Fees? ',
      answer_ar: '  ',
      reviewer_notes: '',
      status: 'approved',
      handoff_after: true,
      account_id: 'ignored',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        question: 'Fees?',
        answer_ar: null,
        reviewer_notes: null,
        status: 'approved',
        handoff_after: true,
      },
      version: 4,
    });
  });

  it('requires the displayed version, a whole number of at least 1', () => {
    for (const version of [undefined, null, 0, -1, 1.5, '2', NaN]) {
      expect(parseKbEntryPatch({ version, status: 'approved' })).toEqual({
        ok: false,
        error: 'version must be a whole number of at least 1',
      });
    }
    expect(parseKbEntryPatch({ version: 1, status: 'approved' }).ok).toBe(true);
  });

  it('rejects a blank question, a bad status and a non-boolean flag', () => {
    expect(parseKbEntryPatch({ version: 1, question: ' ' }).ok).toBe(false);
    expect(parseKbEntryPatch({ version: 1, status: 'live' }).ok).toBe(false);
    expect(parseKbEntryPatch({ version: 1, handoff_after: 'yes' }).ok).toBe(
      false
    );
    expect(parseKbEntryPatch({ version: 1, answer_en: 3 }).ok).toBe(false);
  });

  it('rejects an empty or non-object body', () => {
    expect(parseKbEntryPatch({ version: 1 })).toEqual({
      ok: false,
      error: 'Nothing to update',
    });
    expect(parseKbEntryPatch(null).ok).toBe(false);
    expect(parseKbEntryPatch([]).ok).toBe(false);
  });

  it('caps lengths', () => {
    expect(
      parseKbEntryPatch({ version: 1, category: 'x'.repeat(201) }).ok
    ).toBe(false);
  });
});

describe('isUnusableApprovalError', () => {
  it('matches only the approved-usable CHECK', () => {
    expect(
      isUnusableApprovalError({
        code: '23514',
        message:
          'new row for relation "kb_entries" violates check constraint "kb_entries_approved_usable"',
      })
    ).toBe(true);
    expect(
      isUnusableApprovalError({ code: '23514', message: 'other_check' })
    ).toBe(false);
    expect(isUnusableApprovalError(null)).toBe(false);
  });
});

describe('isKbWorkbookName', () => {
  it('accepts .xlsx only', () => {
    expect(isKbWorkbookName('KB v3.XLSX')).toBe(true);
    expect(isKbWorkbookName('kb.xls')).toBe(false);
    expect(isKbWorkbookName('kb.csv')).toBe(false);
  });
});

describe('summarizeKb / clientReadiness', () => {
  const s = summarizeKb([
    { audience: 'prospective_client', status: 'approved' },
    { audience: 'prospective_client', status: 'draft' },
    { audience: 'existing_client', status: 'to_confirm' },
    { audience: 'internal_staff', status: 'approved' },
  ]);

  it('counts every audience × status cell', () => {
    expect(s.prospective_client).toEqual({
      approved: 1,
      draft: 1,
      to_confirm: 0,
      remove: 0,
    });
    expect(s.internal_staff.approved).toBe(1);
  });

  it('readiness leaves internal staff out', () => {
    expect(clientReadiness(s)).toEqual({ approved: 1, total: 3 });
    expect(clientReadiness(summarizeKb([]))).toEqual({
      approved: 0,
      total: 0,
    });
  });
});

describe('clientReadiness', () => {
  it('does not count rows marked remove', () => {
    const s = summarizeKb([
      { audience: 'prospective_client', status: 'approved' },
      { audience: 'existing_client', status: 'remove' },
      { audience: 'existing_client', status: 'draft' },
    ]);
    expect(clientReadiness(s)).toEqual({ approved: 1, total: 2 });
    expect(s.existing_client.remove).toBe(1);
  });
});

describe('isKbEntryId', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isKbEntryId('6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isKbEntryId('e1')).toBe(false);
    expect(isKbEntryId("1' or 1=1")).toBe(false);
  });
});

describe('kbEntryMatches', () => {
  const entry = {
    ref: 'PC-001',
    audience: 'prospective_client' as const,
    status: 'approved' as const,
    category: 'Fees',
    question: 'How much does it cost?',
    answer_en: 'It depends.',
    answer_ar: 'يعتمد',
  };
  const all = { audience: 'all' as const, status: 'all' as const, query: '' };

  it('filters by audience, status and search', () => {
    expect(kbEntryMatches(entry, all)).toBe(true);
    expect(kbEntryMatches(entry, { ...all, audience: 'existing_client' })).toBe(
      false
    );
    expect(kbEntryMatches(entry, { ...all, status: 'draft' })).toBe(false);
    expect(kbEntryMatches(entry, { ...all, query: ' pc-0 ' })).toBe(true);
    expect(kbEntryMatches(entry, { ...all, query: 'يعتمد' })).toBe(true);
    expect(kbEntryMatches(entry, { ...all, query: 'mortgage' })).toBe(false);
  });
});
