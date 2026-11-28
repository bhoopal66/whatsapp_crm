import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { GET } from './route';

const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const get = (q: string) => GET(new Request(`http://x/api/desk/group-wall${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-active',
    salesRestricted: false,
  });
  m.rpc.mockResolvedValue({ data: [], error: null });
});

describe('GET /api/desk/group-wall', () => {
  it('asks for the ids in order as the caller in the active account', async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          group_id: id(2),
          bank_code: 'RAK',
          bank_name: 'RAKBANK',
          short_code: 'RAK',
          primary_name: 'P',
          second_name: null,
          filed_today: '3',
          to_sort: 2,
          oldest_age_seconds: 7800,
          alert: 'second',
        },
      ],
      error: null,
    });
    const res = await get(`?ids=${id(2)},${id(1)},${id(2)}`);
    expect(res.status).toBe(200);
    const [fn, args] = m.rpc.mock.lastCall!;
    expect(fn).toBe('desk_group_wall');
    expect(args).toMatchObject({
      p_actor: 'u-1',
      p_account: 'acc-active',
      p_group_ids: [id(2), id(1)],
    });
    expect((await res.json()).banks).toEqual([
      expect.objectContaining({
        groupId: id(2),
        filedToday: 3,
        alert: 'second',
      }),
    ]);
  });

  it('no ids asks nothing', async () => {
    const res = await get('');
    expect(await res.json()).toEqual({ banks: [] });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('refuses a bad id or more groups than the wall holds', async () => {
    expect((await get('?ids=x')).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => id(i)).join(',');
    expect((await get(`?ids=${nine}`)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps a refusal with DESK_REFUSAL_HTTP', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'NOT_ALLOWED', message: 'x' },
    });
    const res = await get(`?ids=${id(1)}`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ALLOWED');
  });
});
