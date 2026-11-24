import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadPipelineDonut } from './queries';

const ROWS = [
  { stage_id: 's1', currency: 'AED', deal_count: 2, total_value: 500 },
  { stage_id: 's2', currency: 'USD', deal_count: 1, total_value: 100 },
];

function fakeDb(
  rpcResult: { data: unknown; error: unknown },
  tableError: unknown = null
) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  const table = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'gte', 'lt', 'order']) b[k] = () => b;
    b.then = (f: (r: unknown) => unknown) =>
      Promise.resolve({
        data: tableError ? null : rows,
        count: 0,
        error: tableError,
      }).then(f);
    return b;
  };
  const from = vi.fn((t: string) =>
    table(
      t === 'pipeline_stages'
        ? [
            { id: 's1', name: 'New', color: '#111' },
            { id: 's2', name: 'Won', color: '#222' },
          ]
        : []
    )
  );
  return { db: { rpc, from } as unknown as SupabaseClient, rpc };
}

describe('dashboard pipeline donut', () => {
  it('folds the open-deals RPC into stage slices', async () => {
    const { db, rpc } = fakeDb({ data: ROWS, error: null });
    const donut = await loadPipelineDonut(db);
    expect(rpc.mock.calls).toEqual([['dashboard_open_deal_values']]);
    expect(donut.stages.map((s) => [s.id, s.dealCount])).toEqual([
      ['s1', 2],
      ['s2', 1],
    ]);
    expect(donut.stages.map((s) => s.totals)).toEqual([
      [{ currency: 'AED', value: 500 }],
      [{ currency: 'USD', value: 100 }],
    ]);
  });

  it('rejects when the stages fail to load, never an empty chart', async () => {
    const { db } = fakeDb({ data: ROWS, error: null }, new Error('stages'));
    await expect(loadPipelineDonut(db)).rejects.toThrow('stages');
  });

  it('rejects when the RPC fails, so the panel shows its error', async () => {
    const { db } = fakeDb({ data: null, error: new Error('boom') });
    await expect(loadPipelineDonut(db)).rejects.toThrow('boom');
  });
});
