import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchOpenDeals, loadMetrics, loadPipelineDonut } from './queries';

const ROWS = [
  { stage_id: 's1', deal_count: 2, total_value: 500 },
  { stage_id: 's2', deal_count: 1, total_value: 100 },
];

function fakeDb(rpcResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  const table = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'gte', 'lt', 'order']) b[k] = () => b;
    b.then = (f: (r: unknown) => unknown) =>
      Promise.resolve({ data: rows, count: 0, error: null }).then(f);
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

describe('dashboard open-deals RPC', () => {
  it('is called once per load and feeds both sections', async () => {
    const { db, rpc } = fakeDb({ data: ROWS, error: null });
    const openDeals = fetchOpenDeals(db);
    const [metrics, donut] = await Promise.all([
      loadMetrics(db, openDeals),
      loadPipelineDonut(db, openDeals),
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(metrics.openDealsCount).toBe(3);
    expect(metrics.openDealsValue).toBe(600);
    expect(donut.totalValue).toBe(600);
  });

  it('keeps each section’s own error handling on a shared failure', async () => {
    const { db, rpc } = fakeDb({ data: null, error: new Error('boom') });
    const openDeals = fetchOpenDeals(db);
    const [metrics, donut] = await Promise.allSettled([
      loadMetrics(db, openDeals),
      loadPipelineDonut(db, openDeals),
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(metrics.status).toBe('fulfilled');
    expect(donut.status).toBe('rejected');
  });
});
