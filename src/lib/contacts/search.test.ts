import { describe, expect, it } from 'vitest';

import {
  contactSearchFilter,
  escapeIlike,
  parseContactOptions,
  sanitizeContactSearch,
} from './search';

describe('contactSearchFilter', () => {
  it('matches name or phone, case-insensitively', () => {
    expect(contactSearchFilter('Ali')).toBe(
      'name.ilike.%Ali%,phone.ilike.%Ali%'
    );
  });
  it('drops filter syntax so the request stays well-formed', () => {
    expect(contactSearchFilter('Acme, Inc (UK)')).toBe(
      'name.ilike.%Acme  Inc  UK%,phone.ilike.%Acme  Inc  UK%'
    );
  });
  it('is null for an empty or syntax-only term', () => {
    expect(contactSearchFilter('')).toBeNull();
    expect(contactSearchFilter(' (,) ')).toBeNull();
  });
  it('also matches the phone digits for a number typed without spaces', () => {
    expect(contactSearchFilter('588336503')).toBe(
      'name.ilike.%588336503%,phone.ilike.%588336503%,' +
        'phone_normalized.like.%588336503%'
    );
    expect(contactSearchFilter('+971 58 833 6503')).toContain(
      'phone_normalized.like.%971588336503%'
    );
    expect(contactSearchFilter('Elsa')).not.toContain('phone_normalized');
  });
  it('keeps a phone number intact', () => {
    expect(sanitizeContactSearch('+971 50')).toBe('+971 50');
  });
});

describe('parseContactOptions', () => {
  it('keeps well-formed rows and nulls a missing name', () => {
    expect(
      parseContactOptions([
        { id: 'a', name: 'Ali', phone: '+97150' },
        { id: 'b', name: null, phone: '+97151' },
        { id: 'c', name: 5, phone: '+97152' },
      ])
    ).toEqual([
      { id: 'a', name: 'Ali', phone: '+97150' },
      { id: 'b', name: null, phone: '+97151' },
      { id: 'c', name: null, phone: '+97152' },
    ]);
  });
  it('drops rows without an id or phone, and non-arrays', () => {
    expect(parseContactOptions([{ name: 'x' }, null, { id: 'a' }, 3])).toEqual(
      []
    );
    expect(parseContactOptions(null)).toEqual([]);
    expect(parseContactOptions({ id: 'a', phone: 'p' })).toEqual([]);
  });
});

describe('wildcards', () => {
  it('escapes % and _ and drops * in ilike values', () => {
    expect(escapeIlike('50%_a')).toBe('50\\%\\_a');
    expect(sanitizeContactSearch('al*')).toBe('al');
    expect(contactSearchFilter('a%b_c')).toBe(
      'name.ilike.%a\\%b\\_c%,phone.ilike.%a\\%b\\_c%'
    );
  });

  it('treats a term of only wildcards or punctuation as empty', () => {
    for (const t of ['%%%%', '_', '*', ' % _ * ', '+', '%']) {
      expect(sanitizeContactSearch(t)).toBe('');
      expect(contactSearchFilter(t)).toBeNull();
    }
  });
});
