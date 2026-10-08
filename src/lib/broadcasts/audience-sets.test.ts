import { describe, expect, it } from 'vitest';

import {
  chunk,
  countIdAudience,
  countPhoneAudience,
  countWholeAudience,
  finalAudience,
  uniqueIds,
} from './audience-sets';

const none = new Set<string>();

describe('uniqueIds / chunk', () => {
  it('dedupes in order and drops empty ids', () => {
    expect(uniqueIds(['b', null, 'a', 'b', undefined, ''])).toEqual(['b', 'a']);
  });
  it('splits into runs', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('countIdAudience', () => {
  it('subtracts excluded and opted-out contacts, counting each once', () => {
    expect(
      countIdAudience(
        ['a', 'b', 'b', 'c', 'd'],
        new Set(['c']),
        new Set(['b', 'c', 'z'])
      )
    ).toEqual({ recipients: 2, optedOut: 1 });
  });
  it('is the plain size with nothing to subtract', () => {
    expect(countIdAudience(['a', 'b'], none, none)).toEqual({
      recipients: 2,
      optedOut: 0,
    });
  });
});

describe('countWholeAudience', () => {
  it('subtracts the union of excluded and opted-out', () => {
    expect(
      countWholeAudience(10, new Set(['a', 'b']), new Set(['b', 'c']))
    ).toEqual({ recipients: 7, optedOut: 1 });
  });
  it('never goes below zero', () => {
    expect(countWholeAudience(1, new Set(['a', 'b']), none).recipients).toBe(0);
  });
});

describe('countPhoneAudience', () => {
  it('counts new numbers once, skips opted-out and excluded contacts', () => {
    const existing = new Map([
      ['971500000001', { id: 'c1', optedOut: true }],
      ['971500000002', { id: 'c2', optedOut: false }],
      ['971500000003', { id: 'c3', optedOut: true }],
    ]);
    const keys = [
      '971500000001',
      '971500000002',
      '971500000003',
      '971500000004',
      '971500000004',
    ];
    expect(countPhoneAudience(keys, existing, new Set(['c3']))).toEqual({
      recipients: 2,
      optedOut: 1,
    });
  });
});

describe('finalAudience', () => {
  it('drops excluded and opted-out contacts', () => {
    const contacts = [
      { id: 'a', opted_out_at: null },
      { id: 'b', opted_out_at: '2026-10-01T00:00:00Z' },
      { id: 'c' },
      { id: 'd', opted_out_at: null },
    ];
    expect(finalAudience(contacts, new Set(['d'])).map((c) => c.id)).toEqual([
      'a',
      'c',
    ]);
  });
});
