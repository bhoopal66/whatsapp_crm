import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { GET } from './route';

const get = (query: string) =>
  GET(new Request(`http://x/api/desk/tray${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
  m.rpc.mockResolvedValue({ data: [{ items: [], total: 0 }], error: null });
});

describe('GET /api/desk/tray search (migration 329)', () => {
  it('passes the search, trimmed, as the caller in the active account', async () => {
    const res = await get(`?state=open&q=${encodeURIComponent('  +971 50 ')}`);
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith(
      'desk_tray_page',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_state: 'open',
        p_q: '+971 50',
      })
    );
  });

  it('cuts a long search to 100 characters', async () => {
    await get(`?q=${encodeURIComponent('م'.repeat(150))}`);
    expect(m.rpc.mock.calls[0][1].p_q).toBe('م'.repeat(100));
  });

  it('asks the unsearched tray when q is missing or blank', async () => {
    await get('');
    await get('?q=%20%20');
    expect(m.rpc).toHaveBeenCalledTimes(2);
    for (const [, args] of m.rpc.mock.calls)
      expect(args).not.toHaveProperty('p_q');
  });
});
