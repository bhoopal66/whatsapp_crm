import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

// The invite link is a manager's tool and needs our number to be a
// group admin. Sending it is a 1:1 message from the group's number, so
// the consent register applies: an opted-out or do-not-contact person
// is skipped and reported, never sent to.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  getInviteLink: vi.fn(),
  resetInviteLink: vi.fn(),
  sendInviteLink: vi.fn(),
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
  getInviteLink: mocks.getInviteLink,
  resetInviteLink: mocks.resetInviteLink,
  sendInviteLink: mocks.sendInviteLink,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase(mocks.admin),
}));

import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444441';
const C2 = '44444444-4444-4444-8444-444444444442';
const params = { params: Promise.resolve({ id: G }) };
let canManage = true;

const group = () => ({
  id: G,
  account_id: 'acct-1',
  channel_id: CH,
  wa_group_id: '120363000000000001@g.us',
  our_role: 'admin',
  settings: {},
});

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
      whatsapp_groups: [group()],
      whatsapp_group_invites: [],
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
  mocks.admin = {
    tables: {
      whatsapp_group_invites: [],
      contacts: [
        {
          id: 'hidden',
          account_id: 'acct-1',
          phone_normalized: '971503333333',
          opted_out_at: null,
          do_not_contact_at: '2026-10-02T00:00:00Z',
        },
      ],
    },
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
  mocks.getInviteLink.mockResolvedValue({
    code: 'AbCdEf123',
    link: 'https://chat.whatsapp.com/AbCdEf123',
  });
  mocks.resetInviteLink.mockResolvedValue({
    code: 'NewCode456',
    link: 'https://chat.whatsapp.com/NewCode456',
  });
  mocks.sendInviteLink.mockResolvedValue({ messageId: 'm1' });
});

describe('GET invite', () => {
  it('refuses a non-manager before Whapi', async () => {
    canManage = false;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(403);
    expect(mocks.getInviteLink).not.toHaveBeenCalled();
  });

  it('refuses when our number is not a group admin', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
  });

  it('serves a fresh cached link without Whapi', async () => {
    mocks.rls.tables.whatsapp_group_invites.push({
      group_id: G,
      invite_code: 'Cached123',
      invite_link: 'https://chat.whatsapp.com/Cached123',
      fetched_at: new Date().toISOString(),
    });
    const res = await GET(new Request('http://x'), params);
    expect(await res.json()).toEqual({
      code: 'Cached123',
      link: 'https://chat.whatsapp.com/Cached123',
    });
    expect(mocks.getInviteLink).not.toHaveBeenCalled();
  });

  it('fetches and caches a stale link', async () => {
    mocks.rls.tables.whatsapp_group_invites.push({
      group_id: G,
      invite_code: 'Old123',
      invite_link: 'x',
      fetched_at: '2026-01-01T00:00:00Z',
    });
    const res = await GET(new Request('http://x'), params);
    expect((await res.json()).code).toBe('AbCdEf123');
    expect(mocks.admin.tables.whatsapp_group_invites).toEqual([
      expect.objectContaining({ group_id: G, invite_code: 'AbCdEf123' }),
    ]);
  });
});

describe('POST invite', () => {
  it('resets the link and caches the new one', async () => {
    const res = await post({ action: 'reset' });
    expect((await res.json()).code).toBe('NewCode456');
    expect(mocks.admin.tables.whatsapp_group_invites[0]).toMatchObject({
      invite_code: 'NewCode456',
    });
  });

  it('skips opted-out and do-not-contact people and reports them', async () => {
    const res = await post({
      action: 'send',
      contactIds: [C1, C2],
      phones: ['+971 50 333 3333', '971504444444', 'nope'],
      message: 'Join us',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const sentTo = mocks.sendInviteLink.mock.calls.map((c) => c[0].to);
    expect(sentTo).toEqual(['971501111111', '971504444444']);
    expect(mocks.sendInviteLink.mock.calls[0][0]).toMatchObject({
      inviteCode: 'AbCdEf123',
      body: 'Join us\n%URL%',
    });
    expect(json).toMatchObject({ sent: 2, skipped: 2, failed: 0 });
    expect(json.results).toEqual(
      expect.arrayContaining([
        {
          waId: '971502222222',
          contactId: C2,
          status: 'skipped',
          reason: 'opted_out',
        },
        {
          waId: '971503333333',
          contactId: null,
          status: 'skipped',
          reason: 'do_not_contact',
        },
        { waId: 'nope', contactId: null, status: 'invalid', reason: 'invalid' },
      ])
    );
  });

  it('stops on a number-wide failure and reports the rest', async () => {
    const { WhapiError } = await import('@/lib/whatsapp/whapi-api');
    mocks.sendInviteLink.mockRejectedValueOnce(new WhapiError('rate', 429));
    const res = await post({
      action: 'send',
      phones: ['971504444444', '971505555555'],
    });
    const json = await res.json();
    expect(mocks.sendInviteLink).toHaveBeenCalledTimes(1);
    expect(json.results).toEqual([
      expect.objectContaining({ waId: '971504444444', status: 'failed' }),
      expect.objectContaining({
        waId: '971505555555',
        status: 'not_attempted',
      }),
    ]);
  });

  it('rejects a bad body before any access check', async () => {
    const res = await post({ action: 'send' });
    expect(res.status).toBe(400);
    expect(mocks.getCurrentAccount).toHaveBeenCalled();
    expect(mocks.sendInviteLink).not.toHaveBeenCalled();
  });
});
