import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  listJoinRequests: vi.fn(),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
  getGroup: vi.fn(),
  persistGroupSnapshot: vi.fn(),
  rls: null as unknown as FakeDb,
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
  listJoinRequests: mocks.listJoinRequests,
  approveJoinRequest: mocks.approveJoinRequest,
  rejectJoinRequest: mocks.rejectJoinRequest,
  getGroup: mocks.getGroup,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase({ tables: {} }),
  persistGroupSnapshot: mocks.persistGroupSnapshot,
}));

import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: G }) };
let canManage = true;

const post = (body: unknown) =>
  POST(
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
    },
    rpc: { whatsapp_group_can_manage: () => ({ data: canManage }) },
  };
  mocks.getCurrentAccount.mockImplementation(async () => ({
    supabase: fakeSupabase(mocks.rls),
    userId: 'agent-1',
    accountId: 'acct-1',
    role: 'agent',
  }));
  mocks.loadChannels.mockResolvedValue([
    { id: CH, accountId: 'acct-1', provider: 'whapi', accessToken: 't' },
  ]);
  mocks.listJoinRequests.mockResolvedValue({
    requests: [{ waId: '971504444444', method: 'invite_link' }],
    total: 1,
  });
  mocks.approveJoinRequest.mockResolvedValue({ ok: true, error: null });
  mocks.rejectJoinRequest.mockResolvedValue({ ok: true, error: null });
  mocks.getGroup.mockResolvedValue({ id: '120363000000000001@g.us' });
  mocks.persistGroupSnapshot.mockResolvedValue({});
});

describe('GET requests', () => {
  it('lists pending requests', async () => {
    const res = await GET(new Request('http://x'), params);
    expect(await res.json()).toEqual({
      requests: [{ waId: '971504444444', method: 'invite_link' }],
    });
  });

  it('refuses a non-manager before Whapi', async () => {
    canManage = false;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(403);
    expect(mocks.listJoinRequests).not.toHaveBeenCalled();
  });

  it('answers 409 once our number has left', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'left';
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(409);
  });

  it('answers 403 not_group_admin for a plain member', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
  });
});

describe('POST requests', () => {
  it('approves and resyncs', async () => {
    const res = await post({ applicant: '971504444444', action: 'approve' });
    expect(await res.json()).toEqual({ ok: true, resynced: true });
    expect(mocks.approveJoinRequest.mock.calls[0][0].applicant).toBe(
      '971504444444'
    );
    expect(mocks.persistGroupSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rejects without a resync', async () => {
    const res = await post({ applicant: '971504444444', action: 'reject' });
    expect(await res.json()).toEqual({ ok: true, resynced: false });
    expect(mocks.rejectJoinRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getGroup).not.toHaveBeenCalled();
  });

  it('maps a refused decision to 422', async () => {
    mocks.approveJoinRequest.mockResolvedValue({ ok: false, error: 'gone' });
    const res = await post({ applicant: '971504444444', action: 'approve' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'gone', code: 'request_failed' });
  });

  it('keeps an approval OK when the resync fails', async () => {
    mocks.getGroup.mockRejectedValue(new Error('boom'));
    const res = await post({ applicant: '971504444444', action: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resynced: false });
  });
});
