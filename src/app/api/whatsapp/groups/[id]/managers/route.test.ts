import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  addParticipants: vi.fn(),
  removeParticipants: vi.fn(),
  getGroup: vi.fn(),
  persistGroupSnapshot: vi.fn(),
  role: 'admin' as string,
  userId: 'admin-1',
  rls: null as unknown as FakeDb,
  admin: null as unknown as FakeDb,
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
  addParticipants: mocks.addParticipants,
  removeParticipants: mocks.removeParticipants,
  getGroup: mocks.getGroup,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase(mocks.admin),
  persistGroupSnapshot: mocks.persistGroupSnapshot,
}));

import { GET, PUT } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const U1 = '55555555-5555-4555-8555-555555555551';
const U2 = '55555555-5555-4555-8555-555555555552';
const CREATOR = '55555555-5555-4555-8555-555555555500';
const GUEST = '55555555-5555-4555-8555-555555555599';
const OTHER = '55555555-5555-4555-8555-555555555588';
const CH = '33333333-3333-4333-8333-333333333333';
const WAG = '120363000000000001@g.us';
const OURS = '971509999999';
let canManage = true;
const params = { params: Promise.resolve({ id: G }) };

const put = (body: unknown) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params
  );
const get = () => GET(new Request('http://x'), params);
const managerIds = () =>
  mocks.admin.tables.whatsapp_group_managers.map((r) => r.user_id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.role = 'admin';
  mocks.userId = 'admin-1';
  canManage = true;
  mocks.rls = {
    rpc: { whatsapp_group_can_manage: () => ({ data: canManage }) },
    tables: {
      whatsapp_groups: [
        { id: G, account_id: 'acct-1', created_by: CREATOR, settings: {} },
      ],
    },
  };
  mocks.admin = {
    tables: {
      whatsapp_group_managers: [
        { group_id: G, account_id: 'acct-1', user_id: CREATOR },
        { group_id: G, account_id: 'acct-1', user_id: U1 },
      ],
      profiles: [
        {
          account_id: 'acct-1',
          user_id: CREATOR,
          full_name: 'Cara',
          account_role: 'agent',
          deactivated_at: null,
        },
        {
          account_id: 'acct-1',
          user_id: U1,
          full_name: 'Uma',
          account_role: 'agent',
          deactivated_at: null,
        },
        {
          account_id: 'acct-1',
          user_id: U2,
          full_name: 'Ugo',
          account_role: 'team_leader',
          deactivated_at: null,
        },
        {
          account_id: 'acct-1',
          user_id: GUEST,
          full_name: 'Bank',
          account_role: 'bank_guest',
          deactivated_at: null,
        },
        {
          account_id: 'acct-2',
          user_id: OTHER,
          full_name: 'Other',
          account_role: 'agent',
          deactivated_at: null,
        },
      ],
    },
  };
  mocks.getCurrentAccount.mockImplementation(async () => ({
    supabase: fakeSupabase(mocks.rls),
    userId: mocks.userId,
    accountId: 'acct-1',
    role: mocks.role,
  }));
  mocks.loadChannels.mockResolvedValue([
    {
      id: CH,
      accountId: 'acct-1',
      provider: 'whapi',
      accessToken: 't',
      wabaId: '+971 50 999 9999',
    },
  ]);
  mocks.addParticipants.mockImplementation(
    async ({ participants }: { participants: string[] }) => ({
      added: participants.map((p) => ({ jid: `${p}@s.whatsapp.net`, waId: p })),
      refused: [],
      notAttempted: [],
      invalid: [],
      error: null,
    })
  );
  mocks.removeParticipants.mockImplementation(
    async ({ participants }: { participants: string[] }) => ({
      processed: participants.map((p) => ({
        jid: `${p}@s.whatsapp.net`,
        waId: p,
      })),
      failed: [],
    })
  );
  mocks.getGroup.mockResolvedValue({ id: WAG });
  mocks.persistGroupSnapshot.mockResolvedValue({});
});

describe('GET', () => {
  it('lists managers with names, creator first', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managers: [
        { userId: CREATOR, name: 'Cara', isCreator: true },
        { userId: U1, name: 'Uma', isCreator: false },
      ],
    });
  });

  it('answers 404 for a group the caller cannot see', async () => {
    mocks.rls.tables.whatsapp_groups = [];
    expect((await get()).status).toBe(404);
  });
});

describe('PUT', () => {
  it('replaces the set and always keeps the creator', async () => {
    const res = await put({ userIds: [U2] });
    expect(res.status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U2].sort());
    const body = await res.json();
    expect(body.managers.map((m: { userId: string }) => m.userId)).toEqual([
      CREATOR,
      U2,
    ]);
  });

  it('lets the creator change the set, and refuses another agent', async () => {
    mocks.role = 'agent';
    mocks.userId = 'someone';
    const refused = await put({ userIds: [U2] });
    expect(refused.status).toBe(403);
    expect(managerIds()).toEqual([CREATOR, U1].sort());

    mocks.userId = CREATOR;
    expect((await put({ userIds: [U2] })).status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U2].sort());
  });

  it('refuses a creator who can no longer manage the group; admins still pass', async () => {
    mocks.role = 'agent';
    mocks.userId = CREATOR;
    canManage = false;
    expect((await put({ userIds: [U2] })).status).toBe(403);
    expect(managerIds()).toEqual([CREATOR, U1].sort());

    mocks.role = 'admin';
    mocks.userId = 'admin-1';
    expect((await put({ userIds: [U2] })).status).toBe(200);
  });

  it.each([
    ['a bank guest', GUEST],
    ['another workspace', OTHER],
    ['an unknown id', '55555555-5555-4555-8555-555555555577'],
  ])('refuses %s as invalid_manager', async (_n, uid) => {
    const res = await put({ userIds: [uid] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_manager' });
    expect(managerIds()).toEqual([CREATOR, U1].sort());
  });

  it('drops a manager who was deactivated since, instead of refusing', async () => {
    mocks.admin.tables.profiles.find((p) => p.user_id === U1)!.deactivated_at =
      '2026-11-01T00:00:00Z';
    const res = await put({ userIds: [U1, U2] });
    expect(res.status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U2].sort());
    const { managers } = (await res.json()) as {
      managers: { userId: string }[];
    };
    expect(managers.map((m) => m.userId)).not.toContain(U1);
  });

  it('keeps a deactivated creator, who is always one', async () => {
    mocks.admin.tables.profiles.find(
      (p) => p.user_id === CREATOR
    )!.deactivated_at = '2026-11-01T00:00:00Z';
    const res = await put({ userIds: [CREATOR, U1, U2] });
    expect(res.status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U1, U2].sort());
  });

  it('refuses a deactivated person', async () => {
    mocks.admin.tables.profiles[2].deactivated_at = '2026-10-01T00:00:00Z';
    const res = await put({ userIds: [U2] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_manager' });
  });
});

describe('PUT: manager numbers follow the managers', () => {
  const PHONES: Record<string, string | null> = {
    [U1]: '971500000001',
    [U2]: '+971 50 000 0002',
    [CREATOR]: null,
  };
  beforeEach(() => {
    mocks.rls.tables.whatsapp_groups[0] = {
      ...mocks.rls.tables.whatsapp_groups[0],
      channel_id: CH,
      wa_group_id: WAG,
      our_role: 'admin',
    };
    mocks.admin.rpc = {
      staff_saved_phone: (args) => ({
        data: PHONES[String(args.p_user)] ?? null,
      }),
    };
    mocks.admin.tables.whatsapp_group_participants = [
      { group_id: G, account_id: 'acct-1', wa_id: OURS },
      { group_id: G, account_id: 'acct-1', wa_id: '971500000001' },
    ];
  });

  it('adds a new manager number and removes a dropped manager number', async () => {
    const res = await put({ userIds: [U2] });
    expect(res.status).toBe(200);
    expect(mocks.addParticipants).toHaveBeenCalledTimes(1);
    expect(mocks.addParticipants.mock.calls[0][0]).toMatchObject({
      groupId: WAG,
      participants: ['971500000002'],
    });
    expect(typeof mocks.addParticipants.mock.calls[0][0].deadline).toBe(
      'number'
    );
    expect(mocks.removeParticipants.mock.calls[0][0]).toMatchObject({
      groupId: WAG,
      participants: ['971500000001'],
    });
    expect(mocks.getGroup).toHaveBeenCalled();
    expect((await res.json()).numbers).toEqual({
      added: ['Ugo'],
      removed: ['Uma'],
      failed: [],
    });
  });

  it('does nothing at WhatsApp for people with no saved number', async () => {
    PHONES[U2] = null;
    PHONES[U1] = null;
    try {
      const res = await put({ userIds: [U2] });
      expect(res.status).toBe(200);
      expect(mocks.addParticipants).not.toHaveBeenCalled();
      expect(mocks.removeParticipants).not.toHaveBeenCalled();
      expect((await res.json()).numbers).toEqual({
        added: [],
        removed: [],
        failed: [],
      });
    } finally {
      PHONES[U1] = '971500000001';
      PHONES[U2] = '+971 50 000 0002';
    }
  });

  it('keeps the manager write and reports a gateway failure', async () => {
    mocks.addParticipants.mockRejectedValue(new Error('gateway down'));
    const res = await put({ userIds: [U1, U2] });
    expect(res.status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U1, U2].sort());
    expect((await res.json()).numbers).toEqual({
      added: [],
      removed: [],
      failed: [{ name: 'Ugo', reason: 'unavailable' }],
    });
  });

  it('reports a refused add so the invite link can be shared', async () => {
    mocks.addParticipants.mockResolvedValue({
      added: [],
      refused: [{ jid: '971500000002@s.whatsapp.net', waId: '971500000002' }],
      notAttempted: [],
      invalid: [],
      error: null,
    });
    const res = await put({ userIds: [U1, U2] });
    expect((await res.json()).numbers.failed).toEqual([
      { name: 'Ugo', reason: 'refused' },
    ]);
  });

  it('skips WhatsApp when our number is not a group admin', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await put({ userIds: [U2] });
    expect(res.status).toBe(200);
    expect(managerIds()).toEqual([CREATOR, U2].sort());
    expect(mocks.addParticipants).not.toHaveBeenCalled();
    expect(mocks.removeParticipants).not.toHaveBeenCalled();
    expect((await res.json()).numbers.failed).toEqual([
      { name: 'Ugo', reason: 'not_group_admin' },
      { name: 'Uma', reason: 'not_group_admin' },
    ]);
  });
});
