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
  screenRecipients: vi.fn(),
  rls: null as unknown as FakeDb,
  admin: null as unknown as FakeDb,
}));

// `loadGroupForCaller` asks whether the row mirrors a submission group
// (299); server.load-group.test.ts pins its answers.
vi.mock('@/lib/groups/submission-ids', () => ({
  submissionGroupIds: async () => new Set<string>(),
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

vi.mock('@/lib/groups/recipients', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/groups/recipients')>();
  mocks.screenRecipients.mockImplementation(real.screenRecipients);
  return { ...real, screenRecipients: mocks.screenRecipients };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';

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
  __resetRateLimitForTests();
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

describe('consent override', () => {
  const asRole = (role: string) =>
    mocks.getCurrentAccount.mockImplementation(async () => ({
      supabase: fakeSupabase(mocks.rls),
      userId: 'user-1',
      accountId: 'acct-1',
      role,
    }));

  it('refuses an agent 403 not_allowed before Whapi', async () => {
    const res = await call(POST, { contactIds: [C2], overrideConsent: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_allowed' });
    expect(mocks.screenRecipients).not.toHaveBeenCalled();
    expect(mocks.addParticipants).not.toHaveBeenCalled();
  });

  it('lets an admin add an opted-out contact, logging counts only', async () => {
    asRole('admin');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await call(POST, { contactIds: [C2], overrideConsent: true });
    expect(res.status).toBe(200);
    expect(mocks.screenRecipients).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ contactIds: [C2] }),
      { overrideConsent: true }
    );
    expect(mocks.addParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ participants: ['971502222222'] })
    );
    expect((await res.json()).skipped).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[groups] consent override', {
      groupId: G,
      userId: 'user-1',
      count: 1,
    });
  });

  it('still skips for an admin who did not ask', async () => {
    asRole('admin');
    const res = await call(POST, { contactIds: [C2] });
    expect((await res.json()).skipped).toHaveLength(1);
    expect(mocks.addParticipants).not.toHaveBeenCalled();
  });

  it('answers 400 to a non-boolean overrideConsent', async () => {
    asRole('admin');
    const res = await call(POST, { contactIds: [C2], overrideConsent: 'yes' });
    expect(res.status).toBe(400);
    expect(mocks.screenRecipients).not.toHaveBeenCalled();
  });
});

describe('access', () => {
  // 2026-11-20: adding is open to any agent+ who can open the group.
  it('lets a non-manager agent who can open the group add people', async () => {
    canManage = false;
    const res = await call(POST, { phones: ['971504444444'] });
    expect(res.status).toBe(200);
    expect(mocks.addParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ participants: ['971504444444'] })
    );
  });

  it('refuses a viewer before Whapi', async () => {
    canManage = false;
    mocks.getCurrentAccount.mockImplementation(async () => ({
      supabase: fakeSupabase(mocks.rls),
      userId: 'viewer-1',
      accountId: 'acct-1',
      role: 'viewer',
    }));
    const res = await call(POST, { phones: ['971504444444'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_allowed' });
    expect(mocks.addParticipants).not.toHaveBeenCalled();
  });

  it('still refuses a non-manager removing people', async () => {
    canManage = false;
    const res = await call(DELETE, { waIds: ['971501111111'] });
    expect(res.status).toBe(403);
    expect(mocks.removeParticipants).not.toHaveBeenCalled();
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

  const addMany = (n: number) => {
    mocks.screenRecipients.mockResolvedValueOnce({
      recipients: Array.from({ length: n }, (_, i) => ({
        waId: `9715000${String(i).padStart(5, '0')}`,
      })),
      invalid: [],
      notFound: [],
      skipped: [],
      overridden: 0,
    });
    return call(POST, { contactIds: [C1] });
  };
  const addAs = (userId: string) =>
    mocks.getCurrentAccount.mockImplementation(async () => ({
      supabase: fakeSupabase(mocks.rls),
      userId,
      accountId: 'acct-1',
      role: 'agent',
    }));

  it('logs an override only for people who were added', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await addMany(50)).status).toBe(200);
    // Ten left: of the twenty, all overridden, ten are added.
    mocks.screenRecipients.mockResolvedValueOnce({
      recipients: Array.from({ length: 20 }, (_, i) => ({
        waId: `9715001${String(i).padStart(5, '0')}`,
        contactId: null,
        overridden: true,
      })),
      invalid: [],
      notFound: [],
      skipped: [],
      overridden: 20,
    });
    expect((await call(POST, { contactIds: [C1] })).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      '[groups] consent override',
      expect.objectContaining({ count: 10 })
    );
    warn.mockRestore();
  });

  it('stops one person at 60 people an hour and a number at 120', async () => {
    expect((await addMany(50)).status).toBe(200);
    expect((await addMany(10)).status).toBe(200);
    const over = await addMany(1);
    expect(over.status).toBe(429);
    expect((await over.json()).code).toBe('too_many_adds');
    addAs('agent-2');
    expect((await addMany(50)).status).toBe(200);
    // Ten left on the number: ten are added, forty are not attempted.
    addAs('agent-3');
    const part = await addMany(50);
    expect(part.status).toBe(200);
    expect((await part.json()).added).toHaveLength(10);
    expect(mocks.addParticipants).toHaveBeenCalledTimes(4);
    // The number is spent, though agent-3 has fifty left.
    const last = await addMany(1);
    expect(last.status).toBe(429);
    expect(mocks.addParticipants).toHaveBeenCalledTimes(4);
  });

  it('adds the first who fit and says the rest were not attempted', async () => {
    await addMany(30);
    const res = await addMany(40);
    expect(res.status).toBe(200);
    const sent = mocks.addParticipants.mock.calls[1][0].participants;
    expect(sent).toHaveLength(30);
    const json = await res.json();
    expect(json.added).toHaveLength(30);
    expect(json.notAttempted).toEqual(
      Array.from(
        { length: 10 },
        (_, i) => `971500000${String(30 + i).padStart(3, '0')}`
      )
    );
    expect(json.error).toBe('too_many_adds');
    expect(json.resynced).toBe(true);
  });

  it('spends units only on the people it adds', async () => {
    await addMany(60);
    addAs('agent-2');
    await addMany(50);
    // Ten left on this number, so agent-3 spends ten of sixty...
    addAs('agent-3');
    await addMany(50);
    // ...and on another number the other fifty are still theirs.
    const other = '33333333-3333-4333-8333-333333333334';
    mocks.rls.tables.whatsapp_groups[0].channel_id = other;
    mocks.loadChannels.mockResolvedValue([
      { id: other, accountId: 'acct-1', provider: 'whapi', accessToken: 't' },
    ]);
    const res = await addMany(50);
    expect(res.status).toBe(200);
    expect((await res.json()).added).toHaveLength(50);
  });

  it('keeps what WhatsApp said when both stopped the run', async () => {
    mocks.addParticipants.mockResolvedValueOnce({
      added: [],
      refused: [],
      notAttempted: ['971500000000'],
      invalid: [],
      error: 'rate_limited',
    });
    const json = await (await addMany(61)).json();
    expect(json.error).toBe('rate_limited');
    expect(json.notAttempted).toEqual(['971500000000', '971500000060']);
  });

  it('answers no error when everyone fits', async () => {
    const json = await (await addMany(5)).json();
    expect(json).toMatchObject({ notAttempted: [], error: null });
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
