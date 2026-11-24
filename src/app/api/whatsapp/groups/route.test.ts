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
        'not',
        'or',
        'neq',
        'ilike',
        'order',
        'limit',
        'range',
        'update',
        'upsert',
      ]) {
        q[m] = (...args: unknown[]) => (op.calls.push([m, args]), q);
      }
      q.single = async () => resolve(op);
      q.maybeSingle = async () => resolve(op);
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
  findGroupsNamed: vi.fn(),
  later: [] as Array<() => Promise<void>>,
  admin: null as unknown,
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => void mocks.later.push(fn),
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
  findGroupsNamed: mocks.findGroupsNamed,
  updateGroupInfo: mocks.updateGroupInfo,
  updateGroupSetting: mocks.updateGroupSetting,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => mocks.admin,
  persistGroupSnapshot: mocks.persist,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { WhapiError } from '@/lib/whatsapp/whapi-api';
import { addBudget } from '@/lib/groups/add-budget';
import { GroupCreateUnsupportedError } from '@/lib/whatsapp/groups';
import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555555';
const WA = '120363000000000001@g.us';
const SG = '66666666-6666-4666-8666-666666666666';

let rlsLog: Op[];
let adminLog: Op[];
let canCreate: boolean;
let registry: Array<Record<string, unknown>>;
let staff: string[];
let sgRows: Array<Record<string, unknown>>;
let sgError: unknown;
let sgWaIds: unknown;
let sgWaIdsError: unknown;
let stored: unknown;
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
  __resetRateLimitForTests();
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
  sgRows = [];
  sgError = null;
  sgWaIds = [];
  sgWaIdsError = null;
  stored = null;
  mocks.later.length = 0;
  rpc.mockImplementation(async (fn: string) =>
    fn === 'whatsapp_group_can_create'
      ? { data: canCreate, error: null }
      : fn === 'sg_unread_by_group'
        ? { data: [{ group_id: SG, unread: 2 }], error: null }
        : { data: [G], error: null }
  );
  const rls = fakeDb((op) => {
    if (op.table === 'submission_groups') {
      return { data: sgError ? null : sgRows, error: sgError };
    }
    if (op.table === 'contacts') {
      return { data: [{ id: C1, phone: '+971 50 999 8888' }], error: null };
    }
    return {
      data: [row(), row({ id: 'other', channel_id: null, name: 'Zoo' })],
      error: null,
    };
  }, rlsLog);
  mocks.admin = fakeDb((op) => {
    if (op.table === 'submission_groups') {
      return { data: sgWaIdsError ? null : sgWaIds, error: sgWaIdsError };
    }
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
      if (!op.calls.some(([m]) => m === 'update')) {
        return { data: stored, error: null };
      }
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
      kind: 'group',
      unread: 0,
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
    expect(
      adminLog.find((op) => op.table === 'whatsapp_config')?.calls
    ).toContainEqual(['select', ['id, label, waba_id']]);
  });
});

describe('restricted department', () => {
  it('answers 403 to GET before reading groups', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'u-1',
      accountId: 'acct-1',
      role: 'agent',
      salesRestricted: true,
    });
    const res = await GET(new Request('http://x/api/whatsapp/groups'));
    expect(res.status).toBe(403);
    expect(mocks.loadChannels).not.toHaveBeenCalled();
  });
});

describe('GET /api/whatsapp/groups: submission groups', () => {
  const sg = (over: Record<string, unknown> = {}) => ({
    id: SG,
    channel_id: CH,
    subject: 'Acme x Taamul Credit',
    customer_name: 'Acme LLC',
    submission_ref: 'SUB-1',
    wa_group_id: 'wa-sg',
    last_activity_at: '2026-11-03T10:00:00Z',
    ...over,
  });
  const list = async (url = 'http://x/api/whatsapp/groups') => {
    const res = await GET(new Request(url));
    return { status: res.status, groups: (await res.json()).groups };
  };
  const sgRead = () => rlsLog.find((op) => op.table === 'submission_groups');

  it('adds a submission row with its number and unread count', async () => {
    sgRows = [sg()];
    const { groups } = await list();
    expect(groups[0]).toMatchObject({
      id: SG,
      kind: 'submission',
      name: 'Acme x Taamul Credit',
      channel: { id: CH, name: 'Sales', phone: '971500000000' },
      our_role: 'member',
      can_manage: false,
      unread: 2,
    });
    expect(JSON.stringify(groups)).not.toContain('wa-sg');
  });

  it('drops a mirror of a group the caller cannot see, by the account-wide ids', async () => {
    sgWaIds = [{ wa_group_id: WA }];
    const { groups } = await list();
    expect(groups.map((g: { id: string }) => g.id)).toEqual([]);
    const ids = adminLog.find((op) => op.table === 'submission_groups');
    expect(ids?.calls).toContainEqual(['select', ['wa_group_id']]);
    expect(ids?.calls).toContainEqual(['eq', ['account_id', 'acct-1']]);
  });

  it('reads only ACTIVE groups that exist on WhatsApp', async () => {
    await list();
    const calls = sgRead()?.calls;
    expect(calls).toContainEqual(['eq', ['account_id', 'acct-1']]);
    expect(calls).toContainEqual(['eq', ['status', 'ACTIVE']]);
    expect(calls).toContainEqual(['eq', ['wa_mode', 'group']]);
    expect(calls).toContainEqual(['not', ['wa_group_id', 'is', null]]);
    expect(calls).toContainEqual([
      'order',
      ['last_activity_at', { ascending: false }],
    ]);
  });

  it('takes group details from the RLS client, only ids from the service role', async () => {
    await list();
    expect(sgRead()?.calls[0][1][0]).toContain('subject');
    const admin = adminLog.filter((op) => op.table === 'submission_groups');
    expect(admin).toHaveLength(1);
    expect(admin[0].calls[0]).toEqual(['select', ['wa_group_id']]);
  });

  it('keeps the normal groups when the submission reads fail', async () => {
    sgError = { message: 'boom' };
    sgWaIdsError = { message: 'boom' };
    rpc.mockImplementation(async (fn: string) =>
      fn === 'sg_unread_by_group'
        ? { data: null, error: { message: 'boom' } }
        : { data: [G], error: null }
    );
    const { status, groups } = await list();
    expect(status).toBe(200);
    expect(groups.map((g: { id: string }) => g.id)).toEqual([G, 'other']);
  });

  it('searches subject and customer name with a term safe inside or()', async () => {
    await list('http://x/api/whatsapp/groups?q=a,b(c');
    expect(sgRead()?.calls).toContainEqual([
      'or',
      ['subject.ilike.*a_b_c*,customer_name.ilike.*a_b_c*'],
    ]);
  });

  it('lists none for a viewer, who has no page to open them on', async () => {
    const ctx = await mocks.getCurrentAccount();
    mocks.getCurrentAccount.mockResolvedValue({ ...ctx, role: 'viewer' });
    sgRows = [sg()];
    const { groups } = await list();
    expect(groups.some((g: { kind: string }) => g.kind === 'submission')).toBe(
      false
    );
    expect(sgRead()).toBeUndefined();
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

  it('spends the add budget, and refuses when it is used up', async () => {
    addBudget('agent-1', 'other').spend(59);
    expect((await post(base)).status).toBe(201);
    expect(addBudget('agent-1', CH).remaining()).toBe(0);
    const res = await post(base);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: 'too_many_adds',
      error: expect.stringContaining('try again in 60 min'),
    });
    expect(mocks.createGroup).toHaveBeenCalledTimes(1);
  });

  it('asks WhatsApp only for the people the budget has room for', async () => {
    addBudget('agent-1', 'other').spend(59);
    const res = await post({
      ...base,
      participants: ['971500000001', '971500000002'],
    });
    expect(mocks.createGroup.mock.calls[0][0].participants).toEqual([
      '971500000001',
    ]);
    expect((await res.json()).notAttempted).toContain('971500000002');
  });

  it('caps the groups created on one number in a day', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post({ ...base, name: `T${i}` })).status).toBe(201);
    }
    const res = await post({ ...base, name: 'T10' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'too_many_creates' });
    expect(mocks.createGroup).toHaveBeenCalledTimes(10);
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

describe('POST /api/whatsapp/groups: a create that may have happened', () => {
  const lost = () => new WhapiError('timed out', 503);
  const code = async (res: Response) => (await res.json()).code;

  it.each([
    ['a timeout', lost()],
    ['a gateway 5xx', new WhapiError('bad gateway', 502)],
    ['a 408', new WhapiError('timeout', 408)],
    ['an unknown error', new Error('socket hang up')],
  ])('answers create_unconfirmed to %s', async (_what, err) => {
    mocks.createGroup.mockRejectedValueOnce(err);
    const res = await post(base);
    expect(res.status).toBe(502);
    expect(await code(res)).toBe('create_unconfirmed');
  });

  it('asks before the same name again, whatever its spacing and case', async () => {
    mocks.createGroup.mockRejectedValueOnce(lost());
    await post(base);
    const res = await post({ ...base, name: ' tEAM ' });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('create_repeat');
    expect(mocks.createGroup).toHaveBeenCalledTimes(1);
  });

  it('creates another only for a literal true, and spends no cap on a repeat', async () => {
    expect((await post(base)).status).toBe(201);
    const left = addBudget('agent-1', CH).remaining();
    expect((await post({ ...base, createAnother: 'true' })).status).toBe(409);
    expect(addBudget('agent-1', CH).remaining()).toBe(left);
    expect((await post({ ...base, createAnother: true })).status).toBe(201);
    expect(mocks.createGroup).toHaveBeenCalledTimes(2);
  });

  it('a definite refusal keeps its answer and gives the name back', async () => {
    mocks.createGroup.mockRejectedValueOnce(new WhapiError('no', 403));
    expect(await code(await post(base))).toBe('not_admin');
    mocks.createGroup.mockRejectedValueOnce(
      new GroupCreateUnsupportedError('501')
    );
    expect(await code(await post(base))).toBe('create_unsupported');
    expect((await post(base)).status).toBe(201);
    expect(mocks.later).toHaveLength(0);
  });

  describe('ownership of the group that was made', () => {
    const found = (over: Record<string, unknown> = {}) => ({
      id: WA,
      name: 'Team',
      createdAt: Math.floor(Date.now() / 1000) + 5,
      createdBy: null,
      participants: [],
      ...over,
    });
    const run = async (groups: unknown[], patch: object = {}) => {
      mocks.createGroup.mockRejectedValueOnce(lost());
      mocks.findGroupsNamed.mockResolvedValue(groups);
      mocks.getGroup.mockResolvedValue(found({ participantsCount: 3 }));
      await post({ ...base, managerIds: [M1], ...patch });
      for (const fn of mocks.later) await fn();
    };
    const managers = () =>
      adminLog.find((o) => o.table === 'whatsapp_group_managers')?.calls[0][1];

    it('gives the one new group to its creator and the chosen managers', async () => {
      await run([found(), found({ id: 'old@g.us', createdAt: 1 })]);
      expect(mocks.findGroupsNamed).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Team' })
      );
      expect(mocks.persist).toHaveBeenCalledWith(
        mocks.admin,
        expect.objectContaining({ id: CH }),
        expect.objectContaining({ id: WA, participantsCount: 3 }),
        { createdBy: 'agent-1' }
      );
      expect(managers()?.[0]).toEqual([
        { group_id: G, account_id: 'acct-1', user_id: 'agent-1' },
        { group_id: G, account_id: 'acct-1', user_id: M1 },
      ]);
    });

    it.each([
      ['none', () => []],
      ['two', () => [found(), found({ id: '2@g.us' })]],
      ['an older one', () => [found({ createdAt: 1 })]],
      ['one with no date', () => [found({ createdAt: null })]],
      ["someone else's", () => [found({ createdBy: { waId: '97150111' } })]],
    ])('leaves %s alone', async (_what, groups) => {
      await run(groups());
      expect(mocks.findGroupsNamed).toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
    });

    it('leaves an owned group and a submission group alone', async () => {
      stored = { created_by: 'agent-2' };
      await run([found()]);
      stored = { created_by: null };
      sgWaIds = [{ wa_group_id: WA }];
      await run([found()], { createAnother: true });
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.findGroupsNamed).toHaveBeenCalledTimes(3);
    });

    it('only logs when the look-up fails', async () => {
      mocks.createGroup.mockRejectedValueOnce(lost());
      mocks.findGroupsNamed.mockRejectedValue(new Error('boom'));
      await post(base);
      await expect(mocks.later[0]()).resolves.toBeUndefined();
      expect(mocks.persist).not.toHaveBeenCalled();
    });
  });
});
