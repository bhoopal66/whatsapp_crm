import { describe, it, expect } from 'vitest';
import {
  matchEscalationKeyword,
  parseEscalationKeywords,
  MAX_ESCALATION_KEYWORDS,
} from './escalation';

describe('parseEscalationKeywords', () => {
  it('splits on newlines and commas, trims, lower-cases, de-dupes', () => {
    expect(
      parseEscalationKeywords('Refund\n complaint, LEGAL ,refund\n\n')
    ).toEqual(['refund', 'complaint', 'legal']);
  });

  it('accepts an array as well as a string', () => {
    expect(parseEscalationKeywords(['Manager', ' manager '])).toEqual([
      'manager',
    ]);
  });

  it('collapses internal whitespace in phrases', () => {
    expect(parseEscalationKeywords('close   my  account')).toEqual([
      'close my account',
    ]);
  });

  it('drops a bare wildcard and over-long entries', () => {
    expect(parseEscalationKeywords(['*', 'x'.repeat(200), 'ok'])).toEqual([
      'ok',
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ESCALATION_KEYWORDS + 50 }, (_, i) =>
      String(i)
    );
    expect(parseEscalationKeywords(many)).toHaveLength(MAX_ESCALATION_KEYWORDS);
  });
});

describe('matchEscalationKeyword', () => {
  const KW = ['refund', 'complain*', 'legal', 'close my account', 'شكوى'];

  it('matches a whole word, case-insensitively', () => {
    expect(matchEscalationKeyword('I want a REFUND now', KW)).toBe('refund');
  });

  it('does not match inside another word', () => {
    // "refunded" is not "refund" without the wildcard…
    expect(matchEscalationKeyword('It was refunded already', KW)).toBeNull();
    // …and "preferred" never matches "re"/"refund".
    expect(matchEscalationKeyword('my preferred bank', ['re'])).toBeNull();
  });

  it('a trailing * matches a prefix (poor-man stemming)', () => {
    expect(matchEscalationKeyword('I am complaining!', KW)).toBe('complain*');
    expect(matchEscalationKeyword('a formal complaint', KW)).toBe('complain*');
  });

  it('matches multi-word phrases as a unit', () => {
    expect(matchEscalationKeyword('please close my account', KW)).toBe(
      'close my account'
    );
    expect(matchEscalationKeyword('close the account', KW)).toBeNull();
  });

  it('is Unicode-aware for Arabic', () => {
    expect(matchEscalationKeyword('عندي شكوى على الموظف', KW)).toBe('شكوى');
    // Arabic letters count as word characters: no match mid-word.
    expect(matchEscalationKeyword('الشكوىات', KW)).toBeNull();
  });

  it('treats punctuation as a boundary', () => {
    expect(matchEscalationKeyword('Legal?', KW)).toBe('legal');
    expect(matchEscalationKeyword('(refund)', KW)).toBe('refund');
  });

  it('returns null for empty input or an empty list', () => {
    expect(matchEscalationKeyword('', KW)).toBeNull();
    expect(matchEscalationKeyword('refund', [])).toBeNull();
  });

  it('escapes regex metacharacters in keywords', () => {
    expect(matchEscalationKeyword('cost is $1.5k?', ['$1.5k'])).toBe('$1.5k');
  });
});
