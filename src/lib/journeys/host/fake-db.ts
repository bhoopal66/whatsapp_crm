/** Test-only: a hand-written stand-in for the supabase-js client, for the host adapters' tests. */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Reply {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}
export type Call = [string, ...unknown[]];

/**
 * Each `from(…)` / `rpc(…)` records its chain as one entry of `queries`,
 * e.g. `[['from', 't'], ['select', 'a'], ['eq', 'id', 'x'], ['maybeSingle']]`
 * (an awaited chain ends in `['await']`). Each finished query takes the next
 * of `replies`, in order; once they run out it answers `{ data: null, error: null }`.
 */
export function fakeDb(...replies: Reply[]) {
  const queries: Call[][] = [];
  const answer = (calls: Call[], last: Call) => {
    calls.push(last);
    const r = replies.shift() ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  const chain = (calls: Call[]) => {
    queries.push(calls);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'is'])
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    b.maybeSingle = () => answer(calls, ['maybeSingle']);
    b.then = (ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      answer(calls, ['await']).then(ok, ko);
    return b;
  };
  const db = {
    from: (table: string) => chain([['from', table]]),
    rpc: (fn: string, args: unknown) => chain([['rpc', fn, args]]),
  };
  return { db: db as unknown as SupabaseClient, queries };
}
