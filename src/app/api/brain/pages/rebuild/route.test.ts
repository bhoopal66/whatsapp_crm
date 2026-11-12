import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  enabled: true,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { brain_enabled: m.enabled },
            error: null,
          }),
        }),
      }),
    }),
    rpc: m.rpc,
  }),
}));

import { POST } from './route';

const CASE = '11111111-1111-4111-8111-111111111111';
const asRole = (role: string) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    salesRestricted: false,
    supabase: {},
  });
const post = (body?: unknown) =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

const RPC: Record<string, unknown> = {
  brain_page_dirty_list: [{ kind: 'case', key: CASE, version: 1 }],
  brain_page_sources: [
    {
      item_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      text: 'follow up on the salary letter',
      created_at: '2026-11-10T08:00:00Z',
      source_kind: 'note',
    },
  ],
  brain_page_put: 2,
  brain_page_dirty_count: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  asRole('admin');
  m.rpc.mockImplementation(async (fn: string) => ({
    data: RPC[fn] ?? null,
    error: null,
  }));
});

describe('POST /api/brain/pages/rebuild', () => {
  it('admin rebuilds the account dirty pages, default limit 20', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rebuilt: 1, failed: 0, remaining: 4 });
    expect(m.rpc).toHaveBeenCalledWith('brain_page_dirty_list', {
      p_account: 'acct-1',
      p_limit: 20,
    });
    expect(m.rpc).toHaveBeenCalledWith(
      'brain_page_put',
      expect.objectContaining({ p_account: 'acct-1', p_expected_version: 1 })
    );
  });

  it('takes a limit of 1 and of 50', async () => {
    for (const limit of [1, 50]) {
      m.rpc.mockClear();
      expect((await post({ limit })).status).toBe(200);
      expect(m.rpc).toHaveBeenCalledWith('brain_page_dirty_list', {
        p_account: 'acct-1',
        p_limit: limit,
      });
    }
  });

  it('a limit outside 1..50, not an integer or a bad body is 400, no store call', async () => {
    for (const body of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: '5' },
      [],
    ])
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('non-admin roles are 403 before any store call', async () => {
    for (const role of ['team_leader', 'agent', 'viewer']) {
      asRole(role);
      expect((await post({})).status, role).toBe(403);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('403 brain_disabled while the switch is off', async () => {
    m.enabled = false;
    const res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
