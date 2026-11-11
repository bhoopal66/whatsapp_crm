import { describe, expect, it } from 'vitest';
import { combineOrGroups } from './pagination';
import {
  INBOX_SEARCH_CONTACT_ALIAS,
  inboxSearchQuery,
  matchesInboxSearch,
} from './search';

describe('inboxSearchQuery', () => {
  it('matches the contact by name, phone and phone digits', () => {
    expect(inboxSearchQuery('588336503')).toEqual({
      contactOr:
        'name.ilike.%588336503%,phone.ilike.%588336503%,' +
        'phone_normalized.like.%588336503%',
      group: `${INBOX_SEARCH_CONTACT_ALIAS}.not.is.null,last_message_text.ilike.%588336503%`,
    });
  });

  it('keeps a name search off the digits column', () => {
    expect(inboxSearchQuery(' Elsa ')?.contactOr).toBe(
      'name.ilike.%Elsa%,phone.ilike.%Elsa%'
    );
  });

  it('strips or-filter syntax and is null for nothing left', () => {
    expect(inboxSearchQuery('Acme, Inc')?.group).toBe(
      `${INBOX_SEARCH_CONTACT_ALIAS}.not.is.null,last_message_text.ilike.%Acme  Inc%`
    );
    expect(inboxSearchQuery('  ')).toBeNull();
    expect(inboxSearchQuery('(,)')).toBeNull();
  });

  it('is one group that sits beside the view narrowing', () => {
    const q = inboxSearchQuery('Elsa')!;
    expect(combineOrGroups(['inbox_department.is.null', q.group])).toBe(
      `and(or(inbox_department.is.null),or(${q.group}))`
    );
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
