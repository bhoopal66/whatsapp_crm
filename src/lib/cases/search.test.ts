import { describe, expect, it } from 'vitest';

import { captionCode } from '@/lib/desk/case-number';

import { caseMatchesQuery, readSearchQuery } from './search';

const c = {
  caseNumber: 'TC-26-00001-RAK',
  contactName: 'Aisha Al Mansoori',
  contactOwnName: null,
  submissionRef: 'SUB-77',
};

describe('readSearchQuery', () => {
  it('trims, collapses spaces and drops empty', () => {
    expect(readSearchQuery('  a   b ')).toBe('a b');
    expect(readSearchQuery('   ')).toBeNull();
    expect(readSearchQuery(null)).toBeNull();
    expect(readSearchQuery('x'.repeat(300))).toHaveLength(100);
  });
});

describe('caseMatchesQuery', () => {
  it('matches a full case number and a fragment of it', () => {
    expect(caseMatchesQuery('tc-26-00001-rak', c)).toBe(true);
    expect(caseMatchesQuery('00001', c)).toBe(true);
    expect(caseMatchesQuery('00002', c)).toBe(false);
  });
  it('matches the caption code, case-insensitively', () => {
    const code = captionCode(1, 'RAK');
    expect(caseMatchesQuery(code, c)).toBe(true);
    expect(caseMatchesQuery(code.toLowerCase(), c)).toBe(true);
    expect(caseMatchesQuery(captionCode(2, 'RAK'), c)).toBe(false);
  });
  it('matches the customer name and the submission ref', () => {
    expect(caseMatchesQuery('mansoori', c)).toBe(true);
    expect(caseMatchesQuery('sub-77', c)).toBe(true);
    expect(caseMatchesQuery('nobody', c)).toBe(false);
  });
  it('copes with a case that has no number', () => {
    expect(caseMatchesQuery('TC-26', { ...c, caseNumber: null })).toBe(false);
    expect(
      caseMatchesQuery(captionCode(1, 'RAK'), { ...c, caseNumber: null })
    ).toBe(false);
  });
});
