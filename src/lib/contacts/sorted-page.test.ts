import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contactSearchFilter } from './list-query';
import {
  isMissingSortRpc,
  parseSortedPage,
  SORTED_PAGE_RPC,
  sortedPageRpcArgs,
  type SortedPageView,
} from './sorted-page';

const TAG_A = '11111111-1111-4111-8111-111111111111';
const TAG_B = '22222222-2222-4222-8222-222222222222';

const base: SortedPageView = {
  sort: { sort: 'owner', dir: 'asc' },
  personalOnlyUserId: null,
  search: '',
  chatTagIds: [],
  page: 0,
};

describe('sortedPageRpcArgs', () => {
  it('asks for one page with no filters', () => {
    expect(sortedPageRpcArgs(base, 25)).toEqual({
      p_sort: 'owner',
      p_dir: 'asc',
      p_limit: 25,
      p_offset: 0,
      p_owner_id: null,
      p_search_like: null,
      p_search_digits: null,
      p_chat_tag_ids: null,
      p_sources: null,
    });
  });

  it('turns the page number into an offset', () => {
    const args = sortedPageRpcArgs(
      { ...base, sort: { sort: 'activity', dir: 'desc' }, page: 3 },
      25
    );
    expect(args).toMatchObject({
      p_sort: 'activity',
      p_dir: 'desc',
      p_limit: 25,
      p_offset: 75,
    });
  });

  it('sends the plain search exactly as the plain query filters it', () => {
    const args = sortedPageRpcArgs({ ...base, search: ' 058 833 6503 ' }, 25);
    expect(args.p_search_like).toBe('%058 833 6503%');
    expect(args.p_search_digits).toBe('588336503');
    const filter = contactSearchFilter('058 833 6503');
    expect(filter).toContain(`name.ilike.${args.p_search_like}`);
    expect(filter).toContain(`phone_normalized.like.%${args.p_search_digits}%`);
  });

  it('escapes wildcards and drops a search of punctuation only', () => {
    expect(
      sortedPageRpcArgs({ ...base, search: '100%' }, 25).p_search_like
    ).toBe('%100\\%%');
    const blank = sortedPageRpcArgs({ ...base, search: '(),' }, 25);
    expect(blank.p_search_like).toBeNull();
    expect(blank.p_search_digits).toBeNull();
  });

  it('keeps UUID chat tags only, deduped and in a stable order', () => {
    const args = sortedPageRpcArgs(
      { ...base, chatTagIds: [TAG_B, 'x),or=(1', TAG_A, TAG_B] },
      25
    );
    expect(args.p_chat_tag_ids).toEqual([TAG_A, TAG_B]);
    expect(
      sortedPageRpcArgs({ ...base, chatTagIds: ['nope'] }, 25).p_chat_tag_ids
    ).toBeNull();
  });

  it('passes Unknown through to the function', () => {
    expect(
      sortedPageRpcArgs({ ...base, sources: ['unknown', 'ad'] }, 25).p_sources
    ).toEqual(['ad', 'unknown']);
  });

  it('keeps known lead sources only', () => {
    expect(
      sortedPageRpcArgs({ ...base, sources: ['web_form', 'ghost', 'ad'] }, 25)
        .p_sources
    ).toEqual(['ad', 'web_form']);
    expect(
      sortedPageRpcArgs({ ...base, sources: ['ghost'] }, 25).p_sources
    ).toBeNull();
  });

  it("passes a team leader's own-contacts narrowing", () => {
    expect(
      sortedPageRpcArgs({ ...base, personalOnlyUserId: 'user-1' }, 25)
        .p_owner_id
    ).toBe('user-1');
  });

  it('names exactly the parameters migration 257 declares', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/257_contact_sort.sql'),
      'utf8'
    );
    const signature = sql.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${SORTED_PAGE_RPC}\\(([\\s\\S]*?)\\)\\s*RETURNS`
      )
    );
    expect(signature).not.toBeNull();
    const declared = [...(signature?.[1] ?? '').matchAll(/\b(p_\w+)\s/g)].map(
      (m) => m[1]
    );
    expect(Object.keys(sortedPageRpcArgs(base, 25)).sort()).toEqual(
      declared.sort()
    );
    // The keys the RPC accepts are the TS server keys.
    expect(sql).toContain("p_sort NOT IN ('owner', 'assignee', 'activity')");
  });
});

describe('parseSortedPage', () => {
  it('reads ids in order and the total', () => {
    expect(parseSortedPage({ ids: ['b', 'a', 'b', 7], total: 12 })).toEqual({
      ids: ['b', 'a'],
      total: 12,
    });
    expect(parseSortedPage({ ids: [], total: '3' })).toEqual({
      ids: [],
      total: 3,
    });
  });

  it('refuses anything else', () => {
    expect(parseSortedPage(null)).toBeNull();
    expect(parseSortedPage([])).toBeNull();
    expect(parseSortedPage({ ids: 'a', total: 1 })).toBeNull();
    expect(parseSortedPage({ ids: [], total: -1 })).toBeNull();
    expect(parseSortedPage({ ids: [] })).toBeNull();
  });
});

describe('isMissingSortRpc', () => {
  it('means "257 is not applied" only for the not-found codes', () => {
    expect(isMissingSortRpc({ code: 'PGRST202' })).toBe(true);
    expect(isMissingSortRpc({ code: '42883' })).toBe(true);
    expect(isMissingSortRpc({ code: '42501' })).toBe(false);
    expect(isMissingSortRpc(null)).toBe(false);
  });
});
