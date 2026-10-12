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
