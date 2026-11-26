import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { CaseInboxPage, CaseInboxRow } from './inbox';
import { searchInbox } from './search-inbox';

const row = (id: string, name: string, contactId = `k-${id}`) =>
  ({
    caseId: id,
    contactId,
    contactName: name,
    submissionRef: null,
  }) as unknown as CaseInboxRow;

/** A db whose `cases` and `contacts` reads answer from plain maps. */
function fakeDb(
  numbers: Record<string, string>,
  own: Record<string, string> = {}
) {
  const from = (table: string) => ({
    select: () => ({
      eq: () => ({
        in: async (_c: string, ids: string[]) => ({
          data:
            table === 'cases'
              ? ids
                  .filter((i) => numbers[i])
                  .map((id) => ({ id, case_number: numbers[id] }))
              : ids.filter((i) => own[i]).map((id) => ({ id, name: own[id] })),
          error: null,
        }),
      }),
    }),
  });
  return { from } as unknown as SupabaseClient;
}

const ctx = { userId: 'u', accountId: 'a' };

describe('searchInbox', () => {
  it('keeps matching cases and stops once a page of matches is full', async () => {
    const pages: CaseInboxPage[] = [
      { rows: [row('1', 'Aisha'), row('2', 'Omar')], nextCursor: 'p2' },
      { rows: [row('3', 'Aisha Two')], nextCursor: null },
    ];
    const list = vi.fn(async () => pages.shift()!);
    const out = await searchInbox(
      fakeDb({ '1': 'TC-26-00001-RAK' }),
      { list },
      ctx,
      'aisha',
      {},
      { limit: 50 }
    );
    expect(out.rows.map((r) => r.caseId)).toEqual(['1', '3']);
    expect(out.rows[0]!.caseNumber).toBe('TC-26-00001-RAK');
    expect(out.nextCursor).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('finds by case number and hands back the cursor when enough matched', async () => {
    const list = vi.fn(async () => ({
      rows: [row('1', 'X'), row('2', 'Y')],
      nextCursor: 'more',
    }));
    const out = await searchInbox(
      fakeDb({ '2': 'TC-26-00002-RAK' }),
      { list },
      ctx,
      '00002',
      {},
      { limit: 1 }
    );
    expect(out.rows.map((r) => r.caseId)).toEqual(['2']);
    expect(out.nextCursor).toBe('more');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('matches the contact’s own name', async () => {
    const list = vi.fn(async () => ({
      rows: [row('1', 'Acme LLC')],
      nextCursor: null,
    }));
    const out = await searchInbox(
      fakeDb({}, { 'k-1': 'Sara Khan' }),
      { list },
      ctx,
      'khan',
      {},
      {}
    );
    expect(out.rows).toHaveLength(1);
  });
});

describe('searchInbox and snoozed cases', () => {
  it.each([
    [{}, 'all'],
    [{ snoozed: 'hide' as const }, 'hide'],
    [{ snoozed: 'only' as const }, 'only'],
  ])('%o is read with snoozed %s', async (filters, snoozed) => {
    const list = vi.fn(async () => ({ rows: [], nextCursor: null }));
    await searchInbox(fakeDb({}), { list }, ctx, 'x', filters, {});
    expect(list).toHaveBeenCalledWith('u', 'a', { snoozed }, expect.anything());
  });
});
