import { describe, expect, it } from 'vitest';

import { recyclePager } from './pager';

const row = (id: string, total: number) => ({
  contact_id: id,
  ended_at: '2026-01-01T00:00:00Z',
  total_count: total,
});
const args = { page: 0, pageSize: 25, days: null, search: null };

describe('recyclePager', () => {
  it('asks for the page and takes the total from its rows', async () => {
    const asked: unknown[] = [];
    const load = recyclePager(async (a) => {
      asked.push(a);
      return { data: [row('a', 60)], error: null };
    });
    const out = await load({ ...args, page: 2, days: 30, search: 'sara' });
    expect(asked).toEqual([
      { p_days: 30, p_limit: 25, p_offset: 50, p_search: 'sara' },
    ]);
    expect(out).toMatchObject({ kind: 'rows', total: 60 });
  });

  it('an empty page above the first is past the end, not a total of 0', async () => {
    const load = recyclePager(async () => ({ data: [], error: null }));
    expect(await load({ ...args, page: 3 })).toEqual({ kind: 'past_end' });
    expect(await load(args)).toEqual({ kind: 'rows', rows: [], total: 0 });
  });

  it('drops an answer that lands after a later read was asked for', async () => {
    const settle: ((v: { data: unknown; error: unknown }) => void)[] = [];
    const load = recyclePager(() => new Promise((ok) => void settle.push(ok)));
    const first = load({ ...args, search: 'a' });
    const second = load({ ...args, search: 'ab' });
    settle[1]({ data: [row('second', 1)], error: null });
    settle[0]({ data: null, error: { message: 'slow and failed' } });
    expect(await second).toMatchObject({
      kind: 'rows',
      rows: [{ contactId: 'second' }],
    });
    expect(await first).toEqual({ kind: 'stale' });
  });

  it('a failed read is failed on any page', async () => {
    const load = recyclePager(async () => ({ data: null, error: {} }));
    expect(await load(args)).toEqual({ kind: 'failed' });
    expect(await load({ ...args, page: 2 })).toEqual({ kind: 'failed' });
  });
});
