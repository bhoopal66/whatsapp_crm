import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

// Membership changes are a manager's tool and need our number to be a
// group admin. Adding honours the consent register; removing or
// demoting our own number would strand the group and is refused.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  addParticipants: vi.fn(),
  removeParticipants: vi.fn(),
  promoteAdmins: vi.fn(),
  demoteAdmins: vi.fn(),
  getGroup: vi.fn(),
  persistGroupSnapshot: vi.fn(),
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
  promoteAdmins: mocks.promoteAdmins,
  demoteAdmins: mocks.demoteAdmins,
  getGroup: mocks.getGroup,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase(mocks.admin),
  persistGroupSnapshot: mocks.persistGroupSnapshot,
}));

import { DELETE, PATCH, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444441';
const C2 = '44444444-4444-4444-8444-444444444442';
const OURS = '971509999999';
const params = { params: Promise.resolve({ id: G }) };
let canManage = true;

const call = (fn: typeof POST, body: unknown) =>
  fn(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  canManage = true;
  mocks.rls = {
    tables: {
      whatsapp_groups: [
        {
          id: G,
          account_id: 'acct-1',
          channel_id: CH,
          wa_group_id: '120363000000000001@g.us',
          our_role: 'admin',
          settings: {},
        },
      ],
      contacts: [
        {
          id: C1,
          account_id: 'acct-1',
          phone: '+971 50 111 1111',
          opted_out_at: null,
          do_not_contact_at: null,
        },
        {
          id: C2,
          account_id: 'acct-1',
          phone: '+971502222222',
          opted_out_at: '2026-10-01T00:00:00Z',
          do_not_contact_at: null,
        },
      ],
    },
    rpc: { whatsapp_group_can_manage: () => ({ data: canManage }) },
  };
  mocks.admin = { tables: { contacts: [] } };
  mocks.getCurrentAccount.mockImplementation(async () => ({
    supabase: fakeSupabase(mocks.rls),
    userId: 'agent-1',
    accountId: 'acct-1',
    role: 'agent',
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
      added: participants.map((p) => ({ waId: p })),
      refused: [],
      notAttempted: [],
      invalid: [],
      error: null,
    })
  );
  mocks.removeParticipants.mockResolvedValue({
    processed: [{ waId: '971501111111' }],
    failed: [],
  });
  mocks.promoteAdmins.mockResolvedValue(undefined);
  mocks.demoteAdmins.mockResolvedValue(undefined);
  mocks.getGroup.mockResolvedValue({ id: '120363000000000001@g.us' });
  mocks.persistGroupSnapshot.mockResolvedValue({});
});

describe('access', () => {
  it('refuses a non-manager before Whapi', async () => {
    canManage = false;
    const res = await call(POST, { phones: ['971504444444'] });
    expect(res.status).toBe(403);
    expect(mocks.addParticipants).not.toHaveBeenCalled();
  });

  it('answers 409 once our number has left', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'left';
    const res = await call(DELETE, { waIds: ['971504444444'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'left' });
    expect(mocks.removeParticipants).not.toHaveBeenCalled();
  });

  it('answers 403 not_group_admin when our number is a member', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await call(PATCH, { waIds: ['971504444444'], role: 'admin' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
    expect(mocks.promoteAdmins).not.toHaveBeenCalled();
  });
});

describe('POST participants', () => {
  it('adds, skips the opted-out and resyncs', async () => {
    const res = await call(POST, {
      contactIds: [C1, C2],
      phones: ['971504444444', 'nope'],
    });
    expect(res.status).toBe(200);
    expect(mocks.addParticipants.mock.calls[0][0].participants).toEqual([
      '971501111111',
      '971504444444',
    ]);
    const json = await res.json();
    expect(json).toMatchObject({
      added: [{ waId: '971501111111' }, { waId: '971504444444' }],
      refused: [],
      notAttempted: [],
      invalid: ['nope'],
      resynced: true,
    });
    expect(json.skipped).toEqual([
      { waId: '971502222222', contactId: C2, reason: 'opted_out' },
    ]);
    expect(mocks.persistGroupSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not call Whapi when everyone is skipped', async () => {
    const res = await call(POST, { contactIds: [C2] });
    expect(res.status).toBe(200);
    expect(mocks.addParticipants).not.toHaveBeenCalled();
    expect((await res.json()).skipped).toHaveLength(1);
  });

  it('keeps the response OK when the resync fails', async () => {
    mocks.getGroup.mockRejectedValue(new Error('boom'));
    const res = await call(POST, { phones: ['971504444444'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resynced: false });
  });
});

describe('DELETE participants', () => {
  it('removes people and resyncs', async () => {
    const res = await call(DELETE, { waIds: ['971501111111'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed: [{ waId: '971501111111' }],
      failed: [],
      resynced: true,
    });
  });

  it('refuses to remove our own number', async () => {
    const res = await call(DELETE, { waIds: ['971501111111', OURS] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'own_number' });
    expect(mocks.removeParticipants).not.toHaveBeenCalled();
  });
});

describe('PATCH participants', () => {
  it('promotes and demotes', async () => {
    const up = await call(PATCH, { waIds: ['971504444444'], role: 'admin' });
    expect(await up.json()).toMatchObject({ ok: true, role: 'admin' });
    expect(mocks.promoteAdmins).toHaveBeenCalledTimes(1);
    await call(PATCH, { waIds: ['971504444444'], role: 'member' });
    expect(mocks.demoteAdmins).toHaveBeenCalledTimes(1);
  });

  it('refuses to demote our own number', async () => {
    const res = await call(PATCH, { waIds: [OURS], role: 'member' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'own_number' });
    expect(mocks.demoteAdmins).not.toHaveBeenCalled();
  });
});
