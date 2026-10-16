import { beforeEach, describe, expect, it, vi } from 'vitest';

// The list reads through the caller's RLS; creating needs
// `whatsapp_group_can_create` before any number is loaded or Whapi is
// called, and a group WhatsApp made but we failed to save answers 502
// `saved_failed_run_sync` with its WhatsApp id.

type Op = { table: string; calls: Array<[string, unknown[]]> };
type Resolver = (op: Op) => { data: unknown; error: unknown };

/** A chainable PostgREST stand-in: records each call, resolves per table. */
function fakeDb(resolve: Resolver, log: Op[]) {
  return {
    from(table: string) {
      const op: Op = { table, calls: [] };
      log.push(op);
      const q: Record<string, unknown> = {};
      for (const m of [
        'select',
        'eq',
        'in',
        'is',
        'neq',
        'ilike',
        'order',
        'limit',
        'update',
        'upsert',
      ]) {
        q[m] = (...args: unknown[]) => (op.calls.push([m, args]), q);
      }
      q.single = async () => resolve(op);
      q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(resolve(op)).then(ok, ko);
      return q;
    },
  };
}

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  createGroup: vi.fn(),
  getGroup: vi.fn(),
  updateGroupInfo: vi.fn(),
  updateGroupSetting: vi.fn(),
  persist: vi.fn(),
  admin: null as unknown,
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
  createGroup: mocks.createGroup,
  getGroup: mocks.getGroup,
  updateGroupInfo: mocks.updateGroupInfo,
  updateGroupSetting: mocks.updateGroupSetting,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => mocks.admin,
  persistGroupSnapshot: mocks.persist,
}));

import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555555';
const WA = '120363000000000001@g.us';

let rlsLog: Op[];
let adminLog: Op[];
let canCreate: boolean;
let registry: Array<Record<string, unknown>>;
let staff: string[];
const rpc = vi.fn();

const row = (over: Record<string, unknown> = {}) => ({
  id: G,
  account_id: 'acct-1',
  channel_id: CH,
  wa_group_id: WA,
  name: 'Team',
  description: null,
  icon_url: null,
  participants_count: 2,
  settings: {},
  our_role: 'admin',
  created_by: 'agent-1',
  last_message_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // server.ts's own service-role client (for loadChannels, mocked) only
  // has to construct.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rlsLog = [];
  adminLog = [];
  canCreate = true;
  staff = [M1];
  registry = [];
  rpc.mockImplementation(async (fn: string) =>
    fn === 'whatsapp_group_can_create'
      ? { data: canCreate, error: null }
      : { data: [G], error: null }
  );
  const rls = fakeDb((op) => {
    if (op.table === 'contacts') {
      return { data: [{ id: C1, phone: '+971 50 999 8888' }], error: null };
    }
    return {
      data: [row(), row({ id: 'other', channel_id: null, name: 'Old' })],
      error: null,
    };
  }, rlsLog);
  mocks.admin = fakeDb((op) => {
    if (op.table === 'whatsapp_config') {
      return {
        data: [{ id: CH, label: 'Sales', waba_id: '971500000000' }],
        error: null,
      };
    }
    if (op.table === 'profiles') {
      return { data: staff.map((user_id) => ({ user_id })), error: null };
    }
    if (op.table === 'contacts') return { data: registry, error: null };
    if (op.table === 'whatsapp_groups') {
      return { data: row({ description: 'Hi' }), error: null };
    }
    return { data: null, error: null };
  }, adminLog);
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: { ...rls, rpc },
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
      status: 'connected',
    },
  ]);
  mocks.createGroup.mockResolvedValue({
    group: { id: WA, name: 'Team', participants: [] },
    added: [{ id: '971501234567' }],
    refused: [{ id: '971509998888' }],
    notAttempted: [],
    invalid: [],
    error: null,
  });
  mocks.persist.mockResolvedValue(row());
});

describe('GET /api/whatsapp/groups', () => {
  it('lists with channel labels and can_manage, filtering by name', async () => {
    const res = await GET(new Request('http://x/api/whatsapp/groups?q=50%'));
    expect(res.status).toBe(200);
    const { groups } = await res.json();
    expect(groups[0]).toEqual({
      id: G,
      name: 'Team',
      description: null,
      icon_url: null,
      participants_count: 2,
      our_role: 'admin',
      channel_id: CH,
      channel: { id: CH, name: 'Sales', phone: '971500000000' },
      last_message_at: null,
      created_by: 'agent-1',
      can_manage: true,
    });
    expect(groups[1]).toMatchObject({ channel: null, can_manage: false });
    expect(rlsLog[0].calls).toContainEqual(['ilike', ['name', '%50\\%%']]);
    expect(rlsLog[0].calls).toContainEqual([
      'order',
      ['last_message_at', { ascending: false, nullsFirst: false }],
    ]);
    expect(adminLog[0].calls).toContainEqual([
      'select',
      ['id, label, waba_id'],
    ]);
  });
});

const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

const base = {
  channelId: CH,
  name: 'Team',
  participants: ['+971501234567', 'oops'],
};

describe('POST /api/whatsapp/groups', () => {
  it('refuses a number the caller may not use before anything else', async () => {
    canCreate = false;
    const res = await post(base);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_allowed' });
    expect(rpc).toHaveBeenCalledWith('whatsapp_group_can_create', {
      p_channel: CH,
    });
    expect(mocks.loadChannels).not.toHaveBeenCalled();
    expect(mocks.createGroup).not.toHaveBeenCalled();
  });

  it('refuses a manager who is not live staff', async () => {
    staff = [];
    const res = await post({ ...base, managerIds: [M1] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_manager' });
    expect(mocks.createGroup).not.toHaveBeenCalled();
  });

  it('creates, persists with the creator, adds managers, reports partial adds', async () => {
    const res = await post({
      ...base,
      contactIds: [C1],
      managerIds: [M1],
      description: 'Hi',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(mocks.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Team',
        participants: ['971501234567', '971509998888'],
      })
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      mocks.admin,
      expect.objectContaining({ id: CH }),
      expect.objectContaining({ id: WA }),
      { createdBy: 'agent-1' }
    );
    const mgr = adminLog.find((o) => o.table === 'whatsapp_group_managers')!;
    expect(mgr.calls[0][1][0]).toEqual([
      { group_id: G, account_id: 'acct-1', user_id: 'agent-1' },
      { group_id: G, account_id: 'acct-1', user_id: M1 },
    ]);
    expect(body).toMatchObject({
      group: { id: G, description: 'Hi' },
      added: [{ id: '971501234567' }],
      refused: [{ id: '971509998888' }],
      notAttempted: [],
      invalid: ['oops'],
      warnings: [],
    });
  });

  it('reports a failed setting as a warning, not an error', async () => {
    mocks.updateGroupSetting.mockRejectedValueOnce(new Error('boom'));
    const res = await post({ ...base, settings: { send_messages: 'admins' } });
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual(['settings_not_set']);
  });

  it('answers 502 saved_failed_run_sync when WhatsApp made it but saving failed', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('db down'));
    const res = await post(base);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: 'saved_failed_run_sync',
      wa_group_id: WA,
    });
  });

  it('refuses when no participant is usable', async () => {
    const res = await post({ ...base, participants: ['oops'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'no_participants' });
    expect(mocks.createGroup).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/groups: consent and later batches', () => {
  const twelve = Array.from(
    { length: 12 },
    (_, i) => `9715012300${String(i).padStart(2, '0')}`
  );
  const ident = (waId: string) => ({ jid: `${waId}@s.whatsapp.net`, waId });
  const member = (waId: string) => ({ ...ident(waId), role: 'member' });
  const created = {
    id: WA,
    name: 'Team',
    description: null,
    participantsCount: 6,
    participants: [
      { ...ident('971500000000'), role: 'superadmin' },
      ...twelve.slice(0, 5).map(member),
    ],
  };

  beforeEach(() => {
    mocks.createGroup.mockResolvedValue({
      group: created,
      added: twelve.map(ident),
      refused: [],
      notAttempted: [],
      invalid: [],
      error: null,
    });
  });

  const storedWaIds = () =>
    (
      mocks.persist.mock.calls[0][2] as { participants: { waId: string }[] }
    ).participants.map((p) => p.waId);

  it('stores the re-read group, not the first batch, after a 12-person create', async () => {
    mocks.getGroup.mockResolvedValue({
      ...created,
      participantsCount: 13,
      participants: [created.participants[0], ...twelve.map(member)],
    });
    const res = await post({ ...base, participants: twelve });
    expect(res.status).toBe(201);
    expect(mocks.getGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: WA })
    );
    expect(storedWaIds()).toEqual(expect.arrayContaining(twelve));
  });

  it('merges who was added when the re-read fails', async () => {
    mocks.getGroup.mockRejectedValue(new Error('timeout'));
    const res = await post({ ...base, participants: twelve });
    expect(res.status).toBe(201);
    expect(storedWaIds()).toEqual(expect.arrayContaining(twelve));
    expect(mocks.persist.mock.calls[0][2]).toMatchObject({
      participantsCount: 13,
    });
  });

  it('never sends an opted-out number to WhatsApp, and reports it', async () => {
    registry = [
      {
        id: 'c-out',
        phone_normalized: '971501234567',
        opted_out_at: '2026-10-01T00:00:00Z',
        do_not_contact_at: null,
      },
    ];
    const res = await post({
      ...base,
      participants: ['+971501234567', '+971507654321'],
    });
    expect(res.status).toBe(201);
    expect(mocks.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ participants: ['971507654321'] })
    );
    expect((await res.json()).skipped).toEqual([
      { waId: '971501234567', contactId: null, reason: 'opted_out' },
    ]);
  });
});
