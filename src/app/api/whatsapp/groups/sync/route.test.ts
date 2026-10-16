import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sync is admin and up. Rows a number no longer lists become `left`
// only when that number's listing was complete (not capped).

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  listGroups: vi.fn(),
  persist: vi.fn(),
  existing: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ values: unknown; ids: unknown }>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/channels')>()),
  loadChannels: mocks.loadChannels,
}));
vi.mock('@/lib/whatsapp/groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/groups')>()),
  listGroups: mocks.listGroups,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  persistGroupSnapshot: mocks.persist,
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      let values: unknown = null;
      let ids: unknown = null;
      q.select = () => q;
      q.eq = () => q;
      q.update = (v: unknown) => ((values = v), q);
      q.in = (_c: string, v: unknown) => ((ids = v), q);
      q.then = (ok: (v: unknown) => unknown) => {
        if (values) mocks.updates.push({ values, ids });
        return Promise.resolve(
          values
            ? { data: null, error: null }
            : { data: mocks.existing, error: null }
        ).then(ok);
      };
      return q;
    },
  }),
}));

import { POST, SYNC_GROUPS_PER_CHANNEL } from './route';

const CH = '33333333-3333-4333-8333-333333333333';
const gid = (n: number) => `1203630000000${String(n).padStart(5, '0')}@g.us`;
const group = (n: number) => ({ id: gid(n), name: `G${n}`, participants: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.updates = [];
  mocks.existing = [
    { id: 'row-1', wa_group_id: gid(1), our_role: 'admin' },
    { id: 'row-9', wa_group_id: gid(9), our_role: 'member' },
    { id: 'row-8', wa_group_id: gid(8), our_role: 'left' },
  ];
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: {},
    userId: 'u-1',
    accountId: 'acct-1',
    role: 'admin',
  });
  mocks.loadChannels.mockResolvedValue([
    { id: CH, accountId: 'acct-1', provider: 'whapi', status: 'connected' },
    {
      id: 'meta-1',
      accountId: 'acct-1',
      provider: 'meta',
      status: 'connected',
    },
  ]);
  mocks.listGroups.mockResolvedValue([group(1), group(2)]);
  mocks.persist.mockResolvedValue({});
});

describe('POST /api/whatsapp/groups/sync', () => {
  it('refuses an agent before loading any number', async () => {
    mocks.getCurrentAccount.mockResolvedValueOnce({
      supabase: {},
      userId: 'u-2',
      accountId: 'acct-1',
      role: 'agent',
    });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_allowed' });
    expect(mocks.loadChannels).not.toHaveBeenCalled();
    expect(mocks.listGroups).not.toHaveBeenCalled();
  });

  it('persists every listed group and marks unlisted ones left', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      synced: 2,
      created: 1,
      left: 1,
      truncated: false,
      channels: 1,
    });
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroups).toHaveBeenCalledWith(
      expect.objectContaining({ maxGroups: SYNC_GROUPS_PER_CHANNEL + 1 })
    );
    expect(mocks.persist.mock.calls[0][3]).toBeUndefined();
    expect(mocks.updates).toEqual([
      { values: { our_role: 'left' }, ids: ['row-9'] },
    ]);
  });

  it('marks nothing left when the listing was capped', async () => {
    mocks.listGroups.mockResolvedValue(
      Array.from({ length: SYNC_GROUPS_PER_CHANNEL + 1 }, (_, i) =>
        group(i + 100)
      )
    );
    const res = await POST();
    const body = await res.json();
    expect(body).toMatchObject({
      synced: SYNC_GROUPS_PER_CHANNEL,
      truncated: true,
      left: 0,
    });
    expect(mocks.updates).toEqual([]);
  });
});
