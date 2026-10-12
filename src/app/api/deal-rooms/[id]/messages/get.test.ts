import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  user: null as unknown,
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    toErrorResponse: (err: unknown) =>
      Response.json(
        { error: 'x' },
        { status: err instanceof UnauthorizedError ? 401 : 500 }
      ),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.user }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));

import { GET } from './route';

let mem: ReturnType<typeof memoryDb>;
let admin: ReturnType<typeof memoryDb>;

const msg = (id: string, at: string, extra: Record<string, unknown>) => ({
  id,
  room_id: 'room-1',
  created_at: at,
  type: 'text',
  body: id,
  media: null,
  template_name: null,
  status: null,
  staff_user_id: null,
  sender_participant_id: null,
  ...extra,
});

beforeEach(() => {
  m.getUser.mockResolvedValue({ data: { user: { id: 'guest-1' } } });
  mem = memoryDb({
    deal_rooms: [{ id: 'room-1', account_id: 'acct-1' }],
    group_messages: [
      msg('m1', '2026-10-01T10:00:00.000001Z', {
        direction: 'in',
        sender_participant_id: 'p-cus',
      }),
      msg('m2', '2026-10-01T10:01:00Z', {
        direction: 'out',
        sender_participant_id: 'p-biz',
        staff_user_id: 'staff-1',
        status: 'read',
      }),
      msg('m3', '2026-10-01T10:02:00Z', {
        direction: 'in',
        sender_participant_id: 'p-cus',
        type: 'document',
        body: null,
        media: { id: 'x', filename: 'salary.pdf' },
      }),
      msg('m4', '2026-10-01T10:03:00Z', {
        direction: 'out',
        sender_participant_id: 'p-biz',
        staff_user_id: 'guest-1',
        status: 'sent',
      }),
    ],
    deal_room_roster: [
      {
        id: 'p-cus',
        room_id: 'room-1',
        display_name: 'Ahmed',
        role: 'customer',
      },
      {
        id: 'p-biz',
        room_id: 'room-1',
        display_name: 'Our number',
        role: 'business',
      },
    ],
    group_message_receipts: [
      { message_id: 'm2', participant_id: 'p-cus', status: 'delivered' },
      { message_id: 'm2', participant_id: 'p-cus', status: 'read' },
      { message_id: 'm2', participant_id: 'p-bank', status: 'read' },
      { message_id: 'm2', participant_id: 'p-par', status: 'failed' },
    ],
  });
  admin = memoryDb({
    profiles: [
      {
        user_id: 'staff-1',
        account_id: 'acct-1',
        full_name: 'Sara',
        account_role: 'agent',
        bank_code: null,
      },
      {
        user_id: 'guest-1',
        account_id: 'acct-1',
        full_name: 'Omar',
        account_role: 'bank_guest',
        bank_code: 'HSBC',
      },
      {
        user_id: 'staff-1',
        account_id: 'acct-2',
        full_name: 'Other workspace',
        account_role: 'agent',
        bank_code: null,
      },
    ],
  });
  m.user = {
    auth: { getUser: m.getUser },
    from: (mem.db as { from: unknown }).from,
  };
  m.admin = admin.db;
});

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/deal-rooms/room-1/messages${qs}`), {
    params: Promise.resolve({ id: 'room-1' }),
  });

describe('GET /api/deal-rooms/[id]/messages', () => {
  it('returns the newest page oldest first, named from the roster, staff as "<name> · Taamul", with receipt counts', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.nextBefore).toBeNull();
    expect(body.messages.map((x: { id: string }) => x.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
    expect(body.messages[0]).toMatchObject({
      senderName: 'Ahmed',
      senderRole: 'customer',
      deliveredCount: 0,
      readCount: 0,
    });
    expect(body.messages[1]).toMatchObject({
      senderName: 'Sara · Taamul',
      senderRole: 'staff',
      status: 'read',
      deliveredCount: 2,
      readCount: 2,
    });
    expect(body.messages[2]).toMatchObject({
      type: 'document',
      fileName: 'salary.pdf',
    });
    expect(body.messages[3]).toMatchObject({
      senderName: 'Omar · HSBC',
      senderRole: 'bank_guest',
    });
  });

  it('pages back with before / limit', async () => {
    const first = await (await get('?limit=2')).json();
    expect(first.messages.map((x: { id: string }) => x.id)).toEqual([
      'm3',
      'm4',
    ]);
    expect(first).toMatchObject({
      hasMore: true,
      nextBefore: '2026-10-01T10:02:00Z',
    });
    const older = await (
      await get(`?limit=2&before=${encodeURIComponent(first.nextBefore)}`)
    ).json();
    expect(older.messages.map((x: { id: string }) => x.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(older.hasMore).toBe(false);
  });

  it('refuses a bad query, a room RLS hides (404), and a signed-out caller', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=101')).status).toBe(400);
    expect((await get('?before=yesterday')).status).toBe(400);
    mem.tables.deal_rooms.length = 0;
    expect((await get()).status).toBe(404);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect((await get()).status).toBe(401);
  });
});
