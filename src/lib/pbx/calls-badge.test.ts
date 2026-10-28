import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadCallsBadge } from './calls-badge';

type Res = { count: number | null; error: unknown };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeDb(ext: Promise<Res>, task: Promise<Res>) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const db = {
    from(table: string) {
      const call = { table, filters: [] as [string, unknown][] };
      calls.push(call);
      const b: Record<string, unknown> = {
        select: (_c: string, opts: unknown) => {
          (call as Record<string, unknown>).opts = opts;
          return b;
        },
        eq: (col: string, v: unknown) => {
          call.filters.push([col, v]);
          return b;
        },
        then: (f: (r: Res) => unknown, r?: (e: unknown) => unknown) =>
          (table === 'tasks' ? task : ext).then(f, r),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('loadCallsBadge', () => {
  it('sends both head counts before either resolves, with the exact filters', async () => {
    const ext = deferred<Res>();
    const task = deferred<Res>();
    const { db, calls } = fakeDb(ext.promise, task.promise);
    const out = loadCallsBadge(db, 'u1');
    // Both requests are issued synchronously, before any result.
    expect(calls.map((c) => c.table)).toEqual(['pbx_extensions', 'tasks']);
    expect(calls[1].filters).toEqual([
      ['kind', 'missed_call'],
      ['status', 'open'],
      ['assigned_to', 'u1'],
    ]);
    expect((calls[1] as unknown as { opts: unknown }).opts).toEqual({
      count: 'exact',
      head: true,
    });
    task.resolve({ count: 7, error: null });
    ext.resolve({ count: 2, error: null });
    expect(await out).toEqual({ hasPbx: true, missed: 7 });
  });

  it('reports no PBX and no pill when there are no extensions', async () => {
    const { db } = fakeDb(
      Promise.resolve({ count: 0, error: null }),
      Promise.resolve({ count: 5, error: null })
    );
    expect(await loadCallsBadge(db, 'u1')).toEqual({
      hasPbx: false,
      missed: 0,
    });
  });

  it('shows no pill when the task count errors', async () => {
    const { db } = fakeDb(
      Promise.resolve({ count: 1, error: null }),
      Promise.resolve({ count: null, error: { message: 'x' } })
    );
    expect(await loadCallsBadge(db, 'u1')).toEqual({ hasPbx: true, missed: 0 });
  });
});
