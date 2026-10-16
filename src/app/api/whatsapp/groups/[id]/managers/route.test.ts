import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  role: 'admin' as string,
  userId: 'admin-1',
  rls: null as unknown as FakeDb,
  admin: null as unknown as FakeDb,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase(mocks.admin),
}));

import { GET, PUT } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const U1 = '55555555-5555-4555-8555-555555555551';
const U2 = '55555555-5555-4555-8555-555555555552';
const CREATOR = '55555555-5555-4555-8555-555555555500';
const GUEST = '55555555-5555-4555-8555-555555555599';
const OTHER = '55555555-5555-4555-8555-555555555588';
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

  it('refuses a deactivated person', async () => {
    mocks.admin.tables.profiles[2].deactivated_at = '2026-10-01T00:00:00Z';
    const res = await put({ userIds: [U2] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_manager' });
  });
});
