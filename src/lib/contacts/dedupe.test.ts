import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeByPhone,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
} from './dedupe';

describe('normalizeKey', () => {
  it('strips every non-digit', () => {
    expect(normalizeKey('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizeKey('15551234567')).toBe('15551234567');
  });

  it('collapses different formats of the same number to one key', () => {
    expect(normalizeKey('+44 7911 123456')).toBe(normalizeKey('447911123456'));
  });
});

describe('isExactMatch', () => {
  it('treats different formatting of the same digits as exact', () => {
    expect(
      isExactMatch({ id: '1', phone: '+1 555-123-4567' }, '15551234567')
    ).toBe(true);
  });

  it('is false for a trunk-variant (fuzzy) match', () => {
    // last-8 match but not the same full number
    expect(
      isExactMatch({ id: '1', phone: '37063949836' }, '370063949836')
    ).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('detects Postgres 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });
  it('is false for other errors / non-objects', () => {
    expect(isUniqueViolation({ code: '23502' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
  });
});

describe('dedupeByPhone', () => {
  it('keeps the first occurrence and counts in-file duplicates', () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: '+1 555-1111', name: 'A' },
      { phone: '15551111', name: 'B' }, // same digits as #1
      { phone: '+1 555-2222', name: 'C' },
    ]);
    expect(unique.map((r) => r.name)).toEqual(['A', 'C']);
    expect(duplicates).toBe(1);
  });

  it('drops rows with no digits', () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: '   ' },
      { phone: '+1 555-3333' },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe('findExistingContact', () => {
  // Minimal SupabaseClient stub: resolves the
  // .from().select().eq().order().order().like() chain to a fixed
  // candidate set, recording the ordering it was asked for.
  function stubDb(
    rows: Array<{ id: string; phone: string }>,
    onLike?: (column: string, pattern: string) => void,
    onOrder?: (column: string, options?: { ascending?: boolean }) => void
  ): SupabaseClient {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: (column: string, options?: { ascending?: boolean }) => {
        onOrder?.(column, options);
        return builder;
      },
      like: (column: string, pattern: string) => {
        onLike?.(column, pattern);
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return { from: () => builder } as unknown as SupabaseClient;
  }

  it('asks for candidates oldest first so ties are stable', async () => {
    const orders: Array<[string, boolean | undefined]> = [];
    const db = stubDb([], undefined, (c, o) => orders.push([c, o?.ascending]));
    await findExistingContact(db, 'acct', '971504555843');
    expect(orders).toEqual([
      ['created_at', true],
      ['id', true],
    ]);
  });

  it('prefers the exact digits match over an older last-8 twin', async () => {
    // The local-format twin was created first and shares the last 8
    // digits; the inbound number is the full international one.
    const db = stubDb([
      { id: 'local', phone: '50 455 5843' },
      { id: 'intl', phone: '971 50 455 5843' },
    ]);
    const hit = await findExistingContact(db, 'acct', '971504555843');
    expect(hit?.id).toBe('intl');
  });

  it('falls back to the oldest fuzzy match when no row is exact', async () => {
    const db = stubDb([
      { id: 'older', phone: '0504555843' },
      { id: 'newer', phone: '50 455 5843' },
    ]);
    const hit = await findExistingContact(db, 'acct', '971504555843');
    expect(hit?.id).toBe('older');
  });

  it('suffix-filters on phone_normalized, not the raw phone column', async () => {
    // A contact saved as "971 50 455 5843" has whitespace inside the
    // last eight digits, so a LIKE on `phone` would miss it and the
    // webhook would drop the message after the unique-index rejection.
    let filtered: [string, string] | undefined;
    const db = stubDb([{ id: 'c1', phone: '971 50 455 5843' }], (c, p) => {
      filtered = [c, p];
    });
    const hit = await findExistingContact(db, 'acct', '971504555843');
    expect(filtered).toEqual(['phone_normalized', '%04555843']);
    expect(hit?.id).toBe('c1');
  });

  it('returns a trunk-variant match via phonesMatch', async () => {
    const db = stubDb([{ id: 'c1', phone: '37063949836' }]);
    const hit = await findExistingContact(db, 'acct', '+370 063 949 836');
    expect(hit?.id).toBe('c1');
  });

  it('returns null when no candidate matches', async () => {
    const db = stubDb([{ id: 'c1', phone: '15559999999' }]);
    const hit = await findExistingContact(db, 'acct', '+1 555-123-4567');
    expect(hit).toBeNull();
  });

  it('returns null for an empty phone without querying', async () => {
    const db = stubDb([{ id: 'c1', phone: '15551234567' }]);
    expect(await findExistingContact(db, 'acct', '   ')).toBeNull();
  });
});
