import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { markOptedOut } from './opt-out';

/**
 * A `contacts` table of one row behind the query builder: the UPDATE
 * honours the filters it is given, so a repeat call matches nothing.
 */
function contactsDb(row: {
  id: string;
  account_id: string;
  opted_out_at: string | null;
}) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe('contacts');
      let patch: Record<string, unknown> = {};
      const filters: [string, string, unknown][] = [];
      const b = {
        update(p: Record<string, unknown>) {
          patch = p;
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push(['eq', col, val]);
          return b;
        },
        is(col: string, val: unknown) {
          filters.push(['is', col, val]);
          return b;
        },
        async select() {
          const r = row as Record<string, unknown>;
          const hit = filters.every(([, col, val]) => r[col] === val);
          if (!hit) return { data: [], error: null };
          Object.assign(row, patch);
          writes.push(patch);
          return { data: [{ id: row.id }], error: null };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, writes };
}

describe('markOptedOut', () => {
  it('marks the contact once, then reports nothing new on a repeat', async () => {
    const row = { id: 'c-1', account_id: 'acct-1', opted_out_at: null };
    const { db, writes } = contactsDb(row);

    expect(
      await markOptedOut(db, { accountId: 'acct-1', contactId: 'c-1' })
    ).toBe(true);
    const first = row.opted_out_at;
    expect(typeof first).toBe('string');

    expect(
      await markOptedOut(db, { accountId: 'acct-1', contactId: 'c-1' })
    ).toBe(false);
    // The first stamp is kept: it records when they first asked.
    expect(row.opted_out_at).toBe(first);
    expect(writes).toHaveLength(1);
  });

  it("never marks another account's contact", async () => {
    const row = { id: 'c-1', account_id: 'acct-2', opted_out_at: null };
    const { db } = contactsDb(row);
    expect(
      await markOptedOut(db, { accountId: 'acct-1', contactId: 'c-1' })
    ).toBe(false);
    expect(row.opted_out_at).toBeNull();
  });

  it('logs and returns false instead of throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      from() {
        throw new Error('db down');
      },
    } as unknown as SupabaseClient;
    expect(
      await markOptedOut(failing, { accountId: 'acct-1', contactId: 'c-1' })
    ).toBe(false);
    const errored = {
      from() {
        const b = {
          update: () => b,
          eq: () => b,
          is: () => b,
          select: async () => ({ data: null, error: { message: 'denied' } }),
        };
        return b;
      },
    } as unknown as SupabaseClient;
    expect(
      await markOptedOut(errored, { accountId: 'acct-1', contactId: 'c-1' })
    ).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
