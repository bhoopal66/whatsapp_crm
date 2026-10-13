import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  user: null as unknown,
  access: 'staff' as string | null,
  canManage: false,
}));

vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireRole: vi.fn(),
    toErrorResponse: (err: unknown) =>
      Response.json(
        { error: 'x' },
        { status: err instanceof UnauthorizedError ? 401 : 500 }
      ),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.user }));

import { GET as list } from '../route';
import { GET } from './route';

let mem: ReturnType<typeof memoryDb>;

beforeEach(() => {
  m.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  m.access = 'staff';
  m.canManage = false;
  mem = memoryDb(
    {
      deal_rooms: [
        {
          id: 'room-1',
          channel_id: 'ch-1',
          subject: 'Mortgage',
          status: 'open',
          participant_count: 3,
          window_until: new Date(Date.now() + 3_600_000).toISOString(),
          created_at: '2026-10-01T09:00:00Z',
          created_by: 'user-9',
          deal: { title: 'Ahmed home loan' },
          contact: { name: 'Ahmed' },
        },
      ],
      deal_room_participants: [
        {
          id: 'p-cus',
          room_id: 'room-1',
          display_name: 'Ahmed',
          role: 'customer',
          status: 'joined',
          consent_id: 'c-1',
          phone: '971501234512',
          expected: true,
          bank_code: null,
        },
        {
          id: 'p-bank',
          room_id: 'room-1',
          display_name: 'Officer',
          role: 'bank_guest',
          status: 'pending_approval',
          consent_id: null,
          phone: '447700900123',
          expected: true,
          bank_code: 'HSBC',
        },
      ],
      deal_room_roster: [
        {
          id: 'p-cus',
          room_id: 'room-1',
          display_name: 'Ahmed',
          role: 'customer',
          status: 'joined',
          joined_at: null,
          left_at: null,
        },
      ],
      deal_room_join_requests: [
        {
          id: 'jr-1',
          room_id: 'room-1',
          join_request_id: 'meta-jr-1',
          wa_id: '971559876543',
          received_at: '2026-10-02T00:00:00Z',
          decision: 'pending',
        },
        {
          id: 'jr-2',
          room_id: 'room-1',
          join_request_id: 'meta-jr-2',
          wa_id: '971551111111',
          received_at: '2026-10-02T00:00:00Z',
          decision: 'approved',
        },
      ],
    },
    {
      rpc: (fn) =>
        fn === 'deal_room_access'
          ? m.access
          : fn === 'deal_room_can_manage'
            ? m.canManage
            : null,
    }
  );
  m.user = {
    auth: { getUser: m.getUser },
    from: (mem.db as { from: unknown }).from,
    rpc: (mem.db as { rpc: unknown }).rpc,
  };
});

const get = () =>
  GET(new Request('http://localhost/api/deal-rooms/room-1'), {
    params: Promise.resolve({ id: 'room-1' }),
  });

describe('GET /api/deal-rooms/[id]', () => {
  it('gives staff the people with role, status, consent and the phone masked', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      access: 'staff',
      canManage: false,
      windowOpen: true,
      room: {
        id: 'room-1',
        dealTitle: 'Ahmed home loan',
        contactName: 'Ahmed',
        createdBy: 'user-9',
      },
    });
    expect(body.participants).toEqual([
      expect.objectContaining({
        id: 'p-cus',
        role: 'customer',
        status: 'joined',
        consent: true,
        phone: '+971 XXXXXXX12',
      }),
      expect.objectContaining({
        id: 'p-bank',
        role: 'bank_guest',
        consent: false,
        phone: '+44 XXXXXXXX23',
      }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/501234512|7700900123/);
    expect(body.joinRequests).toBeUndefined();
    expect(body.pendingApprovals).toBeUndefined();
  });

  it('gives managers the pending join requests (masked) and the people awaiting approval', async () => {
    m.canManage = true;
    const body = await (await get()).json();
    expect(body.canManage).toBe(true);
    expect(body.joinRequests).toEqual([
      {
        id: 'jr-1',
        joinRequestId: 'meta-jr-1',
        waId: '+971 XXXXXXX43',
        receivedAt: '2026-10-02T00:00:00Z',
      },
    ]);
    expect(body.pendingApprovals.map((p: { id: string }) => p.id)).toEqual([
      'p-bank',
    ]);
    expect(JSON.stringify(body)).not.toContain('559876543');
  });

  it('gives a guest the roster only, never deal_room_participants', async () => {
    m.access = 'guest';
    // RLS hides deal_rooms from a guest: the room comes from the view.
    const [room] = mem.tables.deal_rooms as Record<string, unknown>[];
    mem.tables.deal_room_guest_rooms = [
      {
        id: room.id,
        channel_id: room.channel_id,
        subject: room.subject,
        status: room.status,
        participant_count: room.participant_count,
        window_until: room.window_until,
        created_at: room.created_at,
      },
    ];
    mem.tables.deal_rooms = [];
    const body = await (await get()).json();
    expect(body.access).toBe('guest');
    expect(body.room).toMatchObject({
      id: 'room-1',
      subject: 'Mortgage',
      contactId: null,
      dealId: null,
      lastError: null,
      createdBy: null,
      dealTitle: null,
      contactName: null,
    });
    expect(body.participants).toEqual([
      {
        id: 'p-cus',
        displayName: 'Ahmed',
        role: 'customer',
        status: 'joined',
        joinedAt: null,
        leftAt: null,
      },
    ]);
    const read = mem.log.map((l) => l.table);
    expect(read).not.toContain('deal_room_participants');
    expect(read).not.toContain('deal_room_join_requests');
    expect(mem.rpcCalls.map(([fn]) => fn)).not.toContain(
      'deal_room_can_manage'
    );
  });

  it('answers 404 to someone who cannot see the room, and 401 signed out', async () => {
    m.access = null;
    expect((await get()).status).toBe(404);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect((await get()).status).toBe(401);
  });
});

describe('GET /api/deal-rooms', () => {
  it('lists what RLS shows the caller, with the deal title and contact name', async () => {
    const res = await list(new Request('http://localhost/api/deal-rooms'));
    expect(res.status).toBe(200);
    expect((await res.json()).rooms).toEqual([
      expect.objectContaining({
        id: 'room-1',
        channelId: 'ch-1',
        subject: 'Mortgage',
        status: 'open',
        participantCount: 3,
        dealTitle: 'Ahmed home loan',
        contactName: 'Ahmed',
        createdAt: '2026-10-01T09:00:00Z',
      }),
    ]);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect(
      (await list(new Request('http://localhost/api/deal-rooms'))).status
    ).toBe(401);
  });
});
