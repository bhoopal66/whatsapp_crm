import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cutSeats = vi.hoisted(() => vi.fn());
vi.mock('./cut', () => ({ cutSeats }));

import { runSeatAccessSweep } from './lapse';

interface Seat {
  id: string;
  account_id: string;
  user_id: string;
}
type Row = Record<string, unknown>;

/** Filters rows as PostgREST would, so the predicate itself is tested. */
function fakeAdmin(opts: {
  seats: Seat[];
  profiles: Row[];
  failProfilesOf?: string;
  failCloseOf?: string;
}) {
  const closed: string[] = [];
  let reads = 0;
  const from = (table: string) => {
    let rows: Row[] =
      table === 'profiles'
        ? opts.profiles
        : opts.seats.map((s) => ({
            ...s,
            left_at: closed.includes(s.id) ? 'now' : null,
            cf_session_id: `cf-${s.id}`,
          }));
    let patch: Row | null = null;
    let account: unknown;
    const q: Record<string, unknown> = {};
    const keep = (fn: (r: Row) => boolean) => ((rows = rows.filter(fn)), q);
    q.select = () => q;
    q.update = (p: Row) => ((patch = p), q);
    q.eq = (c: string, v: unknown) => {
      if (c === 'account_id') account = v;
      return keep((r) => r[c] === v);
    };
    q.is = (c: string, v: unknown) => keep((r) => (r[c] ?? null) === v);
    q.neq = (c: string, v: unknown) => keep((r) => r[c] !== v);
    q.in = (c: string, v: unknown[]) => keep((r) => v.includes(r[c]));
    q.gt = (c: string, v: string) => keep((r) => (r[c] as string) > v);
    q.order = () => q;
    q.limit = (n: number) => ((rows = rows.slice(0, n)), q);
    q.then = (ok: (v: unknown) => unknown) => {
      if (patch) {
        if (rows[0]?.id === opts.failCloseOf) {
          return ok({ data: null, error: { code: 'boom' } });
        }
        closed.push(...rows.map((r) => r.id as string));
      } else reads += 1;
      return ok(
        table === 'profiles' && account === opts.failProfilesOf
          ? { data: null, error: { code: 'down' } }
          : { data: rows, error: null }
      );
    };
    return q;
  };
  return {
    admin: { from } as unknown as SupabaseClient,
    closed,
    reads: () => reads,
  };
}

const seat = (id: string, user_id: string, account_id = 'a'): Seat => ({
  id,
  account_id,
  user_id,
});
const staff = (user_id: string, over: Row = {}): Row => ({
  user_id,
  account_id: 'a',
  account_role: 'agent',
  deactivated_at: null,
  ...over,
});

describe('runSeatAccessSweep', () => {
  beforeEach(() => {
    cutSeats.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('cuts whoever is no longer live staff of that account, and nobody else', async () => {
    const f = fakeAdmin({
      seats: [
        seat('1', 'live'),
        seat('2', 'removed'),
        seat('3', 'off'),
        seat('4', 'guest'),
        seat('5', 'elsewhere'),
      ],
      profiles: [
        staff('live'),
        staff('off', { deactivated_at: '2026-11-24' }),
        staff('guest', { account_role: 'bank_guest' }),
        staff('elsewhere', { account_id: 'b' }),
      ],
    });
    expect(await runSeatAccessSweep(f.admin)).toEqual({ checked: 5, cut: 4 });
    expect(f.closed).toEqual(['2', '3', '4', '5']);
    expect(cutSeats).toHaveBeenCalledWith(
      ['2', '3', '4', '5'].map((id) =>
        expect.objectContaining({ cf_session_id: `cf-${id}` })
      )
    );
  });

  it('costs one read with nobody in a call, two with only staff', async () => {
    const empty = fakeAdmin({ seats: [], profiles: [] });
    await runSeatAccessSweep(empty.admin);
    expect(empty.reads()).toBe(1);
    const busy = fakeAdmin({
      seats: [seat('1', 'live')],
      profiles: [staff('live')],
    });
    await runSeatAccessSweep(busy.admin);
    expect(busy.reads()).toBe(2);
    expect(cutSeats).not.toHaveBeenCalled();
  });

  it('does not read "no answer" as "gone", and goes on with the rest', async () => {
    const f = fakeAdmin({
      seats: [seat('1', 'x', 'down'), seat('2', 'x'), seat('3', 'y')],
      profiles: [],
      failProfilesOf: 'down',
      failCloseOf: '2',
    });
    expect((await runSeatAccessSweep(f.admin)).cut).toBe(1);
    expect(f.closed).toEqual(['3']);
  });

  it('reaches the seats past the first page', async () => {
    const id = (n: number) => String(n).padStart(4, '0');
    const f = fakeAdmin({
      seats: [
        ...Array.from({ length: 100 }, (_, n) => seat(id(n), 'live')),
        seat(id(100), 'removed'),
      ],
      profiles: [staff('live')],
    });
    expect(await runSeatAccessSweep(f.admin)).toEqual({ checked: 101, cut: 1 });
  });
});
