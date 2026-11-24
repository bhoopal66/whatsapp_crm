import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTACT_SEARCH_MAX_HITS,
  contactSearchArgs,
  isSearchCapped,
} from './search-rpc';

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const none = {
  term: 'zed',
  personalOnlyUserId: null,
  chatTagIds: [],
  sources: [],
};

describe('contactSearchArgs', () => {
  it('sends every filter name, null when off, so PostgREST finds 298', () => {
    expect(contactSearchArgs(none)).toEqual({
      p_term: 'zed',
      p_limit: 500,
      p_owner: null,
      p_sources: null,
      p_chat_tags: null,
    });
  });

  it('sends the owner, the known sources and the tag ids', () => {
    const args = contactSearchArgs({
      term: 'zed',
      personalOnlyUserId: 'u1',
      chatTagIds: [T2, T1, T2, 'not-a-uuid'],
      sources: ['web_form', 'nonsense', 'ad'],
    });
    expect(args.p_owner).toBe('u1');
    expect([...args.p_sources!].sort()).toEqual(['ad', 'web_form']);
    expect(args.p_chat_tags).toEqual([T1, T2]);
  });

  it('asks for what migration 298 caps at, by the names it declares', () => {
    const sql = readFileSync(
      'supabase/migrations/298_contact_search_filters.sql',
      'utf8'
    );
    const decl = /FUNCTION public\.search_contacts\(([^)]*)\)/.exec(sql)![1];
    expect(
      decl
        .split(',')
        .map((p) => p.trim().split(' ')[0])
        .sort()
    ).toEqual(Object.keys(contactSearchArgs(none)).sort());
    expect(sql).toContain(
      `LIMIT least(greatest(coalesce(p_limit, 50), 1), ${CONTACT_SEARCH_MAX_HITS})`
    );
  });
});

describe('isSearchCapped', () => {
  it('says so only when the limit was filled', () => {
    expect(isSearchCapped(499)).toBe(false);
    expect(isSearchCapped(500)).toBe(true);
  });
});

describe('the Contacts list', () => {
  const page = readFileSync(
    'src/app/(dashboard)/contacts/(list)/page.tsx',
    'utf8'
  );
  it('hands its filters to the search', () => {
    expect(page).toMatch(/rpc\(\s*'search_contacts',\s*contactSearchArgs\(/);
  });
  it('says "first N" when the search was cut', () => {
    expect(page).toContain("t('subtitleFirst'");
    expect(page).toContain("t('showingFirst'");
  });
});
