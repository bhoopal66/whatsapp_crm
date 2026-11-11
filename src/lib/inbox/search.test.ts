import { describe, expect, it } from 'vitest';
import { conversationSearchGroup } from '@/lib/contacts/fuzzy-search';
import { combineOrGroups } from './pagination';
import {
  inboxSearchHits,
  isCloseMatch,
  matchesInboxSearch,
  matchesInboxSearchOrHit,
  sortByRank,
} from './search';

const hits = inboxSearchHits('elsa', [
  { contactId: 'c-exact', score: 1, exact: true },
  { contactId: 'c-close-hi', score: 0.8, exact: false },
  { contactId: 'c-close-lo', score: 0.4, exact: false },
]);

describe('inboxSearchHits', () => {
  it('keeps the term, the ids in rank order and a lookup', () => {
    expect(hits.term).toBe('elsa');
    expect(hits.ids).toEqual(['c-exact', 'c-close-hi', 'c-close-lo']);
    expect(hits.rank.get('c-close-lo')).toEqual({
      contactId: 'c-close-lo',
      score: 0.4,
      exact: false,
    });
  });

  it('drops a repeated contact, keeping its first hit', () => {
    const h = inboxSearchHits('x', [
      { contactId: 'a', score: 1, exact: true },
      { contactId: 'a', score: 0.1, exact: false },
    ]);
    expect(h.ids).toEqual(['a']);
    expect(h.rank.get('a')?.exact).toBe(true);
  });
});

describe('the list query group', () => {
  it('sits beside the view narrowing in one or=', () => {
    const group = conversationSearchGroup('Elsa', hits.ids)!;
    expect(group).toBe(
      'contact_id.in.(c-exact,c-close-hi,c-close-lo),' +
        'last_message_text.ilike.%Elsa%'
    );
    expect(combineOrGroups(['inbox_department.is.null', group])).toBe(
      `and(or(inbox_department.is.null),or(${group}))`
    );
  });
});

describe('isCloseMatch', () => {
  it('is a found contact that was not exact', () => {
    expect(isCloseMatch({ contact: { id: 'c-close-hi' } }, hits.rank)).toBe(
      true
    );
    expect(isCloseMatch({ contact: { id: 'c-exact' } }, hits.rank)).toBe(false);
    expect(isCloseMatch({ contact: { id: 'other' } }, hits.rank)).toBe(false);
    expect(isCloseMatch({ contact: null }, hits.rank)).toBe(false);
  });
});

describe('sortByRank', () => {
  const row = (id: string, contactId: string | null, at: string | null) => ({
    id,
    contact: contactId ? { id: contactId } : null,
    last_message_at: at,
  });

  it('puts exact first, then score, then the newest message', () => {
    const rows = [
      row('lo', 'c-close-lo', '2026-11-10T12:00:00Z'),
      row('hi', 'c-close-hi', '2026-11-01T12:00:00Z'),
      row('msg', 'unfound', '2026-11-09T12:00:00Z'),
      row('exact-old', 'c-exact', '2026-10-01T12:00:00Z'),
      row('exact-new', 'c-exact', '2026-11-05T12:00:00Z'),
      row('none', null, null),
    ];
    expect(sortByRank(rows, hits.rank).map((r) => r.id)).toEqual([
      'exact-new',
      'exact-old',
      'msg',
      'none',
      'hi',
      'lo',
    ]);
  });

  it('is plain newest-first with no hits, and leaves its input alone', () => {
    const rows = [
      row('a', 'x', '2026-11-01T00:00:00Z'),
      row('b', 'y', '2026-11-02T00:00:00Z'),
    ];
    expect(sortByRank(rows, new Map()).map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('matchesInboxSearchOrHit', () => {
  const close = {
    last_message_text: 'hello',
    contact: { id: 'c-close-hi', name: 'Elza', phone: '+971 50 000 0000' },
  };

  it('keeps a close match the text match would drop', () => {
    expect(matchesInboxSearch(close, 'elsa')).toBe(false);
    expect(matchesInboxSearchOrHit(close, 'elsa', hits)).toBe(true);
    expect(matchesInboxSearchOrHit(close, ' elsa ', hits)).toBe(true);
  });

  it('ignores hits for another term, and unfound contacts', () => {
    expect(matchesInboxSearchOrHit(close, 'elsab', hits)).toBe(false);
    expect(matchesInboxSearchOrHit(close, 'elsa', null)).toBe(false);
    expect(
      matchesInboxSearchOrHit(
        { ...close, contact: { ...close.contact, id: 'other' } },
        'elsa',
        hits
      )
    ).toBe(false);
  });

  it('still accepts a text match without hits', () => {
    expect(matchesInboxSearchOrHit(close, 'elz', null)).toBe(true);
  });
});

describe('matchesInboxSearch', () => {
  const elsa = {
    last_message_text: 'Thanks, see you',
    contact: { name: 'Elsa', phone: '+971 58 833 6503' },
  };

  it('finds a spaced phone by its digits', () => {
    expect(matchesInboxSearch(elsa, '588336503')).toBe(true);
    expect(matchesInboxSearch(elsa, '0588336503')).toBe(true);
    expect(matchesInboxSearch(elsa, '+971588336503')).toBe(true);
    expect(matchesInboxSearch(elsa, '588336504')).toBe(false);
  });

  it('still matches name, raw phone and last message', () => {
    expect(matchesInboxSearch(elsa, 'elsa')).toBe(true);
    expect(matchesInboxSearch(elsa, '58 833')).toBe(true);
    expect(matchesInboxSearch(elsa, 'SEE YOU')).toBe(true);
    expect(matchesInboxSearch(elsa, 'Anna')).toBe(false);
  });

  it('applies the same sanitising as the server', () => {
    expect(matchesInboxSearch(elsa, 'Thanks, see')).toBe(false);
    expect(matchesInboxSearch({ contact: null }, '')).toBe(true);
  });
});
