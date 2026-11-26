import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  admin: null as unknown,
  approveJoinRequests: vi.fn(),
  rejectJoinRequests: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: m.requireRole,
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/whatsapp/meta-groups', async (orig) => ({
  ...(await orig<object>()),
  approveJoinRequests: m.approveJoinRequests,
  rejectJoinRequests: m.rejectJoinRequests,
}));
vi.mock('@/lib/deal-rooms/shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { POST } from './route';

let mem: ReturnType<typeof memoryDb>;

const request = (id: string, decision = 'pending') => ({
  id: `row-${id}`,
  room_id: 'room-1',
  account_id: 'acct-1',
  join_request_id: id,
  wa_id: '971500000001',
  decision,
});

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/deal-rooms/room-1/join-requests', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  mem = memoryDb({
    deal_rooms: [
      {
        id: 'room-1',
        account_id: 'acct-1',
        status: 'open',
        wa_group_id: 'grp-1',
      },
    ],
    deal_room_join_requests: [
      request('jr-1'),
      request('jr-2'),
      request('jr-3', 'approved'),
    ],
  });
  m.admin = mem.db;
  m.requireRole.mockResolvedValue({
    supabase: { rpc: m.rpc },
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'agent',
  });
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.approveJoinRequests.mockResolvedValue({ done: ['jr-1'], failed: [] });
  m.rejectJoinRequests.mockResolvedValue({ done: [], failed: [] });
});

describe('POST /api/deal-rooms/[id]/join-requests', () => {
  it('asks WhatsApp, then records each decision and audits it', async () => {
    const res = await post({ approve: ['jr-1', 'jr-3'], reject: ['jr-2'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      approved: ['jr-1'],
      rejected: ['jr-2'],
      failed: [],
      skipped: ['jr-3'],
    });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_manage', {
      p_room: 'room-1',
    });
    expect(m.approveJoinRequests).toHaveBeenCalledWith({
      groupId: 'grp-1',
      accessToken: 'tok',
      joinRequestIds: ['jr-1'],
    });
    const rows = mem.tables.deal_room_join_requests;
    expect(
      rows.map((r) => [r.join_request_id, r.decision, r.decided_by ?? null])
    ).toEqual([
      ['jr-1', 'approved', 'user-1'],
      ['jr-2', 'rejected', 'user-1'],
      ['jr-3', 'approved', null],
    ]);
    expect(mem.tables.deal_room_audit).toEqual([
      expect.objectContaining({
        action: 'join_requests_decided',
        actor_id: 'user-1',
      }),
    ]);
  });

  it('leaves a request WhatsApp failed pending', async () => {
    m.approveJoinRequests.mockResolvedValue({
      done: [],
      failed: [{ joinRequestId: 'jr-1', code: 131203, message: 'gone' }],
    });
    const res = await post({ approve: ['jr-1'] });
    expect(await res.json()).toMatchObject({
      approved: [],
      failed: [{ joinRequestId: 'jr-1', error: 'gone' }],
    });
    expect(mem.tables.deal_room_join_requests[0].decision).toBe('pending');
  });

  it('reports a decision someone else recorded first as not recorded, not as done', async () => {
    mem = memoryDb(mem.tables, {
      // Another manager decides between our WhatsApp call and our write.
      beforeUpdate: (table) => {
        if (table === 'deal_room_join_requests')
          mem.tables.deal_room_join_requests[0].decision = 'rejected';
      },
    });
    m.admin = mem.db;
    const body = await (await post({ approve: ['jr-1'] })).json();
    expect(body.approved).toEqual([]);
    expect(body.failed).toEqual([
      expect.objectContaining({ joinRequestId: 'jr-1', code: 'not_recorded' }),
    ]);
    expect(mem.tables.deal_room_join_requests[0].decision).toBe('rejected');
  });

  it('answers 403 to a non-manager and asks WhatsApp nothing', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    const res = await post({ approve: ['jr-1'] });
    expect(res.status).toBe(403);
    expect(m.approveJoinRequests).not.toHaveBeenCalled();
    expect(mem.tables.deal_room_join_requests[0].decision).toBe('pending');
  });

  it('refuses an empty or contradictory body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ approve: ['jr-1'], reject: ['jr-1'] })).status).toBe(
      400
    );
  });
});

describe('who a manager may let in', () => {
  const ask = async (
    participant: Record<string, unknown> | null,
    rule: () => unknown = () => null
  ) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = mem.tables;
    mem = memoryDb(
      {
        ...base,
        deal_room_join_requests: [
          { ...request('jr-1'), wa_id: '971501234567' },
        ],
        deal_room_participants: participant
          ? [{ id: 'p-1', room_id: 'room-1', wa_id: null, ...participant }]
          : [],
      },
      { rpc: (fn) => (fn === 'deal_room_admit_block' ? rule() : null) }
    );
    m.admin = mem.db;
    const res = await post({ approve: ['jr-1'], reject: [] });
    expect(res.status).toBe(200);
    return res.json();
  };
  const listed = { phone: '971501234567', status: 'invited' };

  it.each([
    ['opted_out', listed, () => 'opted_out'],
    ['no_consent', listed, () => 'no_consent'],
    ['pending_approval', { ...listed, status: 'pending_approval' }, () => null],
    ['rejected', { ...listed, status: 'rejected' }, () => null],
    [
      'check_failed',
      listed,
      () => {
        throw { message: 'timeout' };
      },
    ],
    ['check_failed', listed, () => 'a_rule_of_a_later_release'],
  ])('asks WhatsApp nothing for %s', async (code, participant, rule) => {
    const body = await ask(participant, rule);
    expect(m.approveJoinRequests).not.toHaveBeenCalled();
    expect(body.approved).toEqual([]);
    expect(body.failed).toEqual([
      expect.objectContaining({ joinRequestId: 'jr-1', code }),
    ]);
    expect(mem.tables.deal_room_join_requests[0].decision).toBe('pending');
  });

  it('asks the rule about the number that asked, and approves who passes', async () => {
    expect((await ask(listed)).approved).toEqual(['jr-1']);
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_admit_block',
      { p_participant: 'p-1', p_wa_id: '971501234567' },
    ]);
  });

  it('leaves a number nobody listed to the manager', async () => {
    expect((await ask(null)).approved).toEqual(['jr-1']);
  });
});
