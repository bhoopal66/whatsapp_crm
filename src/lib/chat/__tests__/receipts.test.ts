import { describe, expect, it } from 'vitest';

import { RECEIPTS_MAX_MEMBERS, seenBy, showsReceipts } from '../receipts';

describe('seenBy', () => {
  const createdAt = '2026-10-30T10:00:00Z';

  it('splits members by read mark, skips the author, keeps order', () => {
    const r = seenBy({
      createdAt,
      authorId: 'me',
      members: [
        { userId: 'a', lastReadAt: '2026-10-30T10:00:01Z' },
        { userId: 'me', lastReadAt: null },
        { userId: 'b', lastReadAt: null },
        { userId: 'c', lastReadAt: '2026-10-30T09:59:59Z' },
        { userId: 'd', lastReadAt: createdAt },
      ],
    });
    expect(r).toEqual({ seen: ['a', 'd'], unseen: ['b', 'c'] });
  });

  it('compares instants, not strings', () => {
    // Same instant in different notations; string compare would say unseen.
    const r = seenBy({
      createdAt: '2026-10-30T10:00:00Z',
      authorId: null,
      members: [
        { userId: 'a', lastReadAt: '2026-10-30T10:00:00.000+00:00' },
        { userId: 'b', lastReadAt: '2026-10-30T12:00:00+02:00' },
        { userId: 'c', lastReadAt: '2026-10-30T09:59:59.999Z' },
      ],
    });
    expect(r).toEqual({ seen: ['a', 'b'], unseen: ['c'] });
  });
});

describe('showsReceipts', () => {
  it('always for a dm, never for a deal room', () => {
    expect(showsReceipts('dm', 8)).toBe(true);
    expect(showsReceipts('deal_room', 2)).toBe(false);
  });

  it('team and private up to the cap', () => {
    for (const k of ['team', 'private'] as const) {
      expect(showsReceipts(k, RECEIPTS_MAX_MEMBERS)).toBe(true);
      expect(showsReceipts(k, RECEIPTS_MAX_MEMBERS + 1)).toBe(false);
    }
  });
});

describe('seenBy edge cases', () => {
  it('has nobody to report on an empty or author-only list', () => {
    expect(seenBy({ createdAt: 't', authorId: 'a', members: [] })).toEqual({
      seen: [],
      unseen: [],
    });
    expect(
      seenBy({
        createdAt: '2026-10-30T10:00:00Z',
        authorId: 'a',
        members: [{ userId: 'a', lastReadAt: null }],
      })
    ).toEqual({ seen: [], unseen: [] });
  });
});
