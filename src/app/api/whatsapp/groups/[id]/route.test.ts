import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH and DELETE need `whatsapp_group_can_manage` on the caller's RLS
// client: an agent who can see a group but not manage it is refused
// before any number is loaded or Whapi is called. Whapi goes first and
// the service role persists only what WhatsApp accepted.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  canManage: true as boolean,
  group: null as Record<string, unknown> | null,
  loadChannels: vi.fn(),
  updateGroupInfo: vi.fn(),
  updateGroupSetting: vi.fn(),
  leaveGroup: vi.fn(),
  adminUpdates: [] as unknown[],
  submissionRead: { data: [], error: null } as {
    data: Array<{ wa_group_id: string }> | null;
    error: unknown;
  },
}));

vi.mock('@/lib/groups/submission-ids', () => ({
  submissionGroupIds: async () => {
    if (mocks.submissionRead.error) throw mocks.submissionRead.error;
    return new Set(mocks.submissionRead.data?.map((r) => r.wa_group_id));
  },
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
  updateGroupInfo: mocks.updateGroupInfo,
  updateGroupSetting: mocks.updateGroupSetting,
  leaveGroup: mocks.leaveGroup,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      let values: Record<string, unknown> = {};
      q.update = (v: Record<string, unknown>) => (
        (values = v),
        mocks.adminUpdates.push(v),
        q
      );
      for (const m of ['eq', 'select']) q[m] = () => q;
      q.single = async () => ({
        data: { ...mocks.group, ...values },
        error: null,
      });
      return q;
    },
  }),
}));

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

import { DELETE, GET, PATCH } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const WA_ID = '120363000000000001@g.us';
const params = { params: Promise.resolve({ id: G }) };

const rlsClient = {
  from: () => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'range', 'in']) q[m] = () => q;
    q.maybeSingle = async () => ({ data: mocks.group, error: null });
    // The participant and manager lists await the query itself.
    q.then = (done: (v: unknown) => void) => done({ data: [], error: null });
    return q;
  },
  rpc: vi.fn(async (fn: string) => ({
    data: fn === 'whatsapp_group_can_manage' ? mocks.canManage : null,
    error: null,
  })),
};

const patch = (body: unknown) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    params
  );

beforeEach(() => {
  vi.clearAllMocks();
  // server.ts builds its own service-role client for loadChannels,
  // which is mocked; the client only has to construct.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.canManage = true;
  mocks.adminUpdates = [];
  mocks.submissionRead = { data: [], error: null };
  mocks.group = {
    id: G,
    account_id: 'acct-1',
    channel_id: CH,
    wa_group_id: WA_ID,
    name: 'Old',
    description: null,
    settings: {},
    our_role: 'admin',
    created_by: 'someone-else',
  };
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: rlsClient,
    userId: 'agent-1',
    accountId: 'acct-1',
    role: 'agent',
  });
  mocks.loadChannels.mockResolvedValue([
    {
      id: CH,
      accountId: 'acct-1',
      provider: 'whapi',
      accessToken: 't',
      wabaId: '971500000000',
    },
  ]);
});

describe('GET /api/whatsapp/groups/[id]', () => {
  const isSubmissionGroup = async () => {
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    return (await res.json()).is_submission_group;
  };

  it('says false for an ordinary group', async () => {
    expect(await isSubmissionGroup()).toBe(false);
  });

  it('answers 404 for the mirror of a submission group', async () => {
    mocks.submissionRead = { data: [{ wa_group_id: WA_ID }], error: null };
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(404);
  });

  it('answers 503 when the check fails', async () => {
    mocks.submissionRead = { data: null, error: new Error('down') };
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(503);
  });
});

describe('GET: the people in a group', () => {
  let rls: FakeDb;
  const uuid = (n: number) =>
    `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
  const read = async (rows: number) => {
    rls.tables.whatsapp_group_participants = Array.from(
      { length: rows },
      (_, i) => ({
        group_id: G,
        wa_id: String(i).padStart(5, '0'),
        contact_id: i < 450 ? uuid(i) : null,
        role: 'member',
      })
    );
    const ctx = await mocks.getCurrentAccount();
    mocks.getCurrentAccount.mockResolvedValue({
      ...ctx,
      supabase: fakeSupabase(rls),
    });
    return GET(new Request('http://x'), params);
  };

  beforeEach(() => {
    rls = {
      maxRows: 1000,
      rpc: { whatsapp_group_can_manage: () => ({ data: true }) },
      tables: {
        whatsapp_groups: [mocks.group!],
        whatsapp_group_managers: [],
        contacts: Array.from({ length: 450 }, (_, i) => ({
          id: uuid(i),
          name: `C${i}`,
        })),
      },
    };
  });

  it('lists everyone past the first thousand, each once', async () => {
    const { participants } = await (await read(1024)).json();
    expect(participants).toHaveLength(1024);
    expect(
      new Set(participants.map((p: { wa_id: string }) => p.wa_id)).size
    ).toBe(1024);
  });

  it('chunks the contact ids', async () => {
    const sizes: number[] = [];
    const client = fakeSupabase(rls);
    const from = client.from;
    client.from = (table: string) => {
      const q = from(table);
      const real = q.in.bind(q);
      q.in = (col: string, vs: unknown[]) => {
        if (table === 'contacts') sizes.push(vs.length);
        return real(col, vs);
      };
      return q;
    };
    await read(450);
    const ctx = await mocks.getCurrentAccount();
    mocks.getCurrentAccount.mockResolvedValue({ ...ctx, supabase: client });
    await GET(new Request('http://x'), params);
    expect(sizes).toEqual([200, 200, 50]);
  });

  it('answers 503 when the names cannot be read', async () => {
    rls.errors = { 'contacts:select': { message: 'timeout' } };
    expect((await read(3)).status).toBe(503);
  });
});

describe('PATCH /api/whatsapp/groups/[id]', () => {
  it('keeps a setting a colleague saved while WhatsApp was asked', async () => {
    mocks.updateGroupSetting.mockImplementation(async () => {
      mocks.group = {
        ...mocks.group,
        settings: { edit_group_info: 'anyone' },
      };
    });
    const res = await patch({ settings: { send_messages: 'admins' } });
    expect(res.status).toBe(200);
    expect(mocks.adminUpdates).toEqual([
      {
        settings: expect.objectContaining({
          edit_group_info: 'anyone',
          send_messages: 'admins',
        }),
      },
    ]);
  });

  it('refuses an agent who can see the group but not manage it', async () => {
    mocks.canManage = false;
    const res = await patch({ name: 'New' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_allowed' });
    expect(rlsClient.rpc).toHaveBeenCalledWith('whatsapp_group_can_manage', {
      p_group: G,
    });
    expect(mocks.loadChannels).not.toHaveBeenCalled();
    expect(mocks.updateGroupInfo).not.toHaveBeenCalled();
    expect(mocks.adminUpdates).toEqual([]);
  });

  it('is 404 for a group the caller cannot see', async () => {
    mocks.group = null;
    const res = await patch({ name: 'New' });
    expect(res.status).toBe(404);
  });

  it('renames on WhatsApp first, then persists', async () => {
    const res = await patch({ name: '  New  ' });
    expect(res.status).toBe(200);
    expect(mocks.updateGroupInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: '120363000000000001@g.us',
        name: 'New',
      })
    );
    expect(mocks.adminUpdates).toEqual([{ name: 'New' }]);
    expect((await res.json()).group.name).toBe('New');
  });

  it('refuses settings when our number is not a group admin', async () => {
    mocks.group!.our_role = 'member';
    const res = await patch({ settings: { send_messages: 'admins' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
    expect(mocks.updateGroupSetting).not.toHaveBeenCalled();
  });

  it('rejects a bad body before any access check', async () => {
    const res = await patch({ settings: { send_messages: 'everyone' } });
    expect(res.status).toBe(400);
    expect(rlsClient.rpc).not.toHaveBeenCalled();
  });

  it('keeps what WhatsApp accepted when a later setting fails', async () => {
    const { WhapiError } = await import('@/lib/whatsapp/whapi-api');
    mocks.updateGroupSetting
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new WhapiError('boom', 500));
    const res = await patch({
      settings: { send_messages: 'admins', edit_group_info: 'admins' },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'gateway_unavailable' });
    expect(mocks.adminUpdates).toEqual([
      { settings: { send_messages: 'admins' } },
    ]);
  });
});

describe('DELETE /api/whatsapp/groups/[id]', () => {
  it('refuses a non-manager', async () => {
    mocks.canManage = false;
    const res = await DELETE(new Request('http://x'), params);
    expect(res.status).toBe(403);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
  });

  it('leaves on WhatsApp and marks the group left', async () => {
    const res = await DELETE(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.leaveGroup).toHaveBeenCalledTimes(1);
    expect(mocks.adminUpdates).toEqual([{ our_role: 'left' }]);
  });

  it('refuses a mirror of a submission group, with no leave', async () => {
    mocks.submissionRead = { data: [{ wa_group_id: WA_ID }], error: null };
    const res = await DELETE(new Request('http://x'), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.adminUpdates).toEqual([]);
  });

  it('refuses when submission groups cannot be read', async () => {
    mocks.submissionRead = { data: null, error: new Error('down') };
    const res = await DELETE(new Request('http://x'), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'unavailable' });
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.adminUpdates).toEqual([]);
  });
});
