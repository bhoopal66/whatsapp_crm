import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { waitForNumber } from './broadcast-continue';

/** One pending recipient; the filters are PostgREST's business. */
function fake(recipient: { id: string; error_message: string | null }) {
  const moves: unknown[] = [];
  const db = {
    from: (table: string) => {
      let like: string | null = null;
      const chain: Record<string, unknown> = {
        update: (payload: Record<string, unknown>) => {
          if (table === 'broadcasts') moves.push(payload.scheduled_at);
          else Object.assign(recipient, payload);
          return chain;
        },
        like: (_col: string, pattern: string) => {
          like = pattern.replaceAll('%', '');
          return chain;
        },
        then: (done: (r: unknown) => void) =>
          done({
            error: null,
            data:
              like && !recipient.error_message?.includes(like)
                ? []
                : [recipient],
          }),
      };
      for (const m of ['select', 'eq', 'or', 'order', 'limit'])
        chain[m] = () => chain;
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, moves };
}

describe('waitForNumber', () => {
  const due = '2026-11-20T08:00:00.000Z';
  const at = (iso: string) => new Date(iso);

  it('moves the appointment half an hour and says why', async () => {
    const r = { id: 'r1', error_message: null as string | null };
    const { db, moves } = fake(r);
    const bc = { id: 'bc-1', scheduled_at: due };
    expect(await waitForNumber(db, bc, 'No number', at(due))).toBe(true);
    expect(moves).toEqual(['2026-11-20T08:30:00.000Z']);
    expect(r.error_message).toBe(`No number - due since ${due}`);
  });

  it('counts the week from the first appointment, not the moved one', async () => {
    const r = { id: 'r1', error_message: `No number - due since ${due}` };
    const { db, moves } = fake(r);
    const moved = { id: 'bc-1', scheduled_at: '2026-11-27T07:45:00.000Z' };
    expect(
      await waitForNumber(db, moved, 'x', at('2026-11-27T07:45:00Z'))
    ).toBe(true);
    // Not past the week.
    expect(moves).toEqual(['2026-11-27T08:00:00.000Z']);
    expect(
      await waitForNumber(db, moved, 'x', at('2026-11-27T08:00:00Z'))
    ).toBe(false);
    expect(moves).toHaveLength(1);
  });
});
