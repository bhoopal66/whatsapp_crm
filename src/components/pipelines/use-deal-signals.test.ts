import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import {
  DEAL_SIGNAL_SELECT,
  loadDealSignals,
  type SignalClient,
} from './use-deal-signals';

function fakeClient(rows: Record<string, unknown>[]) {
  const calls: { columns: string; ids: string[] }[] = [];
  const client: SignalClient = {
    from: () => ({
      select: (columns) => ({
        in: (_column, ids) => {
          calls.push({ columns, ids });
          return Promise.resolve({
            data: rows.filter((r) => ids.includes(r.contact_id as string)),
            error: null,
          });
        },
      }),
    }),
  };
  return { client, calls };
}

describe('loadDealSignals', () => {
  it('reads every contact in one batched query per 200 ids, not per deal', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`);
    const { client, calls } = fakeClient([]);
    await loadDealSignals(client, [...ids, ...ids]);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.ids.length)).toEqual([200, 200, 50]);
    expect(calls[0].columns).toBe(DEAL_SIGNAL_SELECT);
  });

  it('keys the figures by contact, the most recent chat winning', async () => {
    const { client } = fakeClient([
      { contact_id: 'a', insight_lead_temp: 1, last_message_at: '2026-10-01' },
      { contact_id: 'a', insight_lead_temp: 2, last_message_at: '2026-10-20' },
      { contact_id: 'b', unread_count: 3, last_message_at: null },
    ]);
    const map = await loadDealSignals(client, ['a', 'b']);
    expect(map.get('a')?.insight_lead_temp).toBe(2);
    expect(map.get('b')?.unread_count).toBe(3);
    expect(map.has('c')).toBe(false);
  });

  it('makes no query for no contacts', async () => {
    const { client, calls } = fakeClient([]);
    expect((await loadDealSignals(client, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
