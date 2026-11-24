import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sync is admin and up. Rows a number no longer lists become `left`
// only when that number's listing was complete (not capped).

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  listGroups: vi.fn(),
  complete: true,
  persist: vi.fn(),
  existing: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
  tombstones: [] as Array<Record<string, unknown>>,
  readError: null as unknown,
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
  listGroupsWithStatus: async (args: unknown) => ({
    groups: await mocks.listGroups(args),
    complete: mocks.complete,
  }),
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  persistGroupSnapshot: mocks.persist,
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let values: unknown = null;
      let ids: unknown = null;
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      q.range = () => q;
      q.update = (v: unknown) => ((values = v), q);
      q.in = (_c: string, v: unknown) => ((ids = v), q);
      q.then = (ok: (v: unknown) => unknown) => {
        if (values) mocks.updates.push({ values, ids });
        const skipList =
          table === 'submission_groups'
            ? mocks.submissions
            : table === 'whatsapp_group_tombstones'
              ? mocks.tombstones
              : null;
        if (skipList && mocks.readError) {
          return Promise.resolve({ data: null, error: mocks.readError }).then(
            ok
          );
        }
        return Promise.resolve(
          values
            ? { data: null, error: null }
            : { data: skipList ?? mocks.existing, error: null }
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
  mocks.submissions = [];
  mocks.tombstones = [];
  mocks.readError = null;
  mocks.complete = true;
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

  it('skips a submission group and counts it nowhere', async () => {
    mocks.submissions = [{ wa_group_id: gid(2) }, { wa_group_id: null }];
    const res = await POST();
    expect(await res.json()).toMatchObject({ synced: 1, created: 0 });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist.mock.calls[0][2]).toMatchObject({ id: gid(1) });
  });

  it('skips a tombstoned group and counts it nowhere', async () => {
    mocks.tombstones = [{ wa_group_id: gid(2) }];
    const res = await POST();
    expect(await res.json()).toMatchObject({ synced: 1, created: 0 });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('does not count a group the persist step skipped', async () => {
    mocks.persist.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    const res = await POST();
    expect(await res.json()).toMatchObject({ synced: 1, created: 0 });
  });

  it('does not mark a mirrored submission group left', async () => {
    // row-1 is the mirror: still listed, skipped, and its row stays as is.
    mocks.submissions = [{ wa_group_id: gid(1) }];
    const res = await POST();
    expect(await res.json()).toMatchObject({ synced: 1, left: 1 });
    expect(mocks.updates).toEqual([
      { values: { our_role: 'left' }, ids: ['row-9'] },
    ]);
  });

  it('walks no number whose skip lists cannot be read', async () => {
    mocks.readError = { message: 'down' };
    const res = await POST();
    expect(res.status).toBe(500);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
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

  it('walks company OpenWA numbers, not personal ones', async () => {
    mocks.loadChannels.mockResolvedValue([
      {
        id: CH,
        accountId: 'acct-1',
        provider: 'openwa',
        isPersonal: false,
        status: 'connected',
      },
      {
        id: 'personal-1',
        accountId: 'acct-1',
        provider: 'openwa',
        isPersonal: true,
        status: 'connected',
      },
    ]);
    const res = await POST();
    expect(await res.json()).toMatchObject({ channels: 1, synced: 2 });
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroups.mock.calls[0][0].channel.id).toBe(CH);
    expect(mocks.listGroups.mock.calls[0][0].deadline).toEqual(
      expect.any(Number)
    );
  });

  it('does not believe an empty list until a second sync ten minutes on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      mocks.listGroups.mockResolvedValue([]);
      const first = await (await POST()).json();
      expect(first).toMatchObject({ left: 0, incomplete: true });
      vi.setSystemTime(Date.now() + 9 * 60_000);
      expect(await (await POST()).json()).toMatchObject({ left: 0 });
      expect(mocks.updates).toEqual([]);
      vi.setSystemTime(Date.now() + 60_000);
      const third = await (await POST()).json();
      expect(third).toMatchObject({ left: 2, truncated: false });
      expect(third.incomplete).toBeUndefined();
      expect(mocks.updates).toEqual([
        { values: { our_role: 'left' }, ids: ['row-1', 'row-9'] },
      ]);
      // A listing with groups starts the wait again.
      mocks.listGroups.mockResolvedValueOnce([group(1)]);
      await POST();
      expect(await (await POST()).json()).toMatchObject({
        left: 0,
        incomplete: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks nothing left when the listing was incomplete', async () => {
    // An OpenWA walk that ran out of time or failed a group read.
    mocks.complete = false;
    const res = await POST();
    expect(await res.json()).toMatchObject({
      synced: 2,
      truncated: true,
      left: 0,
    });
    expect(mocks.updates).toEqual([]);
  });
});
