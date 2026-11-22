import { describe, expect, it } from 'vitest';

import {
  classifySearch,
  lookupToCandidate,
  mergeCandidates,
  overviewToCandidates,
} from './case-search';
import type { TrayCandidate } from './tray';

const cand = (
  caseId: string,
  why: TrayCandidate['why'] = []
): TrayCandidate => ({
  caseId,
  caseNumber: `TC-${caseId}`,
  bankCode: 'RAK',
  company: 'Kite Trading',
  product: null,
  why,
});

describe('classifySearch', () => {
  it('knows a case number, a name and too little', () => {
    expect(classifySearch('TC-26-04271-RAK')).toBe('ref');
    expect(classifySearch('Kite Trad')).toBe('name');
    expect(classifySearch('k')).toBe('short');
    expect(classifySearch('  ')).toBe('short');
  });
});

describe('lookupToCandidate', () => {
  it('fills blanks rather than null', () => {
    expect(
      lookupToCandidate({
        caseId: 'c1',
        caseNumber: 'TC-26-00001-RAK',
        bankCode: null,
        companyName: null,
        contactId: null,
        product: 'Loan',
        stage: 'Interested',
      })
    ).toEqual({
      caseId: 'c1',
      caseNumber: 'TC-26-00001-RAK',
      bankCode: '',
      company: '',
      product: 'Loan',
      why: [],
    });
  });
});

describe('overviewToCandidates', () => {
  const o = {
    cases: [
      {
        caseId: 'a',
        caseNumber: 'TC-1',
        bankCode: 'RAK',
        product: 'Loan',
        stage: 's',
        closed: false,
        canRead: true,
        canWrite: true,
      },
      {
        caseId: 'b',
        caseNumber: 'TC-2',
        bankCode: 'FAB',
        product: null,
        stage: 's',
        closed: true,
        canRead: true,
        canWrite: true,
      },
      {
        caseId: 'c',
        caseNumber: 'TC-3',
        bankCode: 'FAB',
        product: null,
        stage: 's',
        closed: false,
        canRead: true,
        canWrite: false,
      },
      {
        caseId: 'd',
        caseNumber: null,
        bankCode: 'FAB',
        product: null,
        stage: 's',
        closed: false,
        canRead: true,
        canWrite: true,
      },
    ],
  };
  it('keeps open, writable, numbered cases only, under the company name', () => {
    expect(overviewToCandidates({ legalName: 'Kite' }, o)).toEqual([
      {
        caseId: 'a',
        caseNumber: 'TC-1',
        bankCode: 'RAK',
        company: 'Kite',
        product: 'Loan',
        why: [],
      },
    ]);
  });
});

describe('mergeCandidates', () => {
  it('keeps the item first and drops repeats', () => {
    const out = mergeCandidates(
      [cand('a', ['code']), cand('b')],
      [cand('b'), cand('c')]
    );
    expect(out.map((c) => c.caseId)).toEqual(['a', 'b', 'c']);
    expect(out[1]!.why).toEqual([]);
    expect(out[0]!.why).toEqual(['code']);
  });
});
