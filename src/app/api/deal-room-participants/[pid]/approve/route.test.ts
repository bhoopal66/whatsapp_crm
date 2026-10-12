import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  admin: null as unknown,
  sendRoomInvites: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: { rpc: m.rpc }, userId: 'tl-1' }),
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/deal-rooms/invites', () => ({
  sendRoomInvites: m.sendRoomInvites,
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    {
      params: Promise.resolve({ pid: 'p-bank' }),
    }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.admin = memoryDb({
    deal_room_participants: [{ id: 'p-bank', room_id: 'room-1' }],
  }).db;
  m.sendRoomInvites.mockResolvedValue({
    sent: 1,
    failed: 0,
    skipped: 0,
    notOpen: false,
    templateMissing: false,
  });
});

describe('POST /api/deal-room-participants/[pid]/approve', () => {
  it('approves as the caller, then sends the room invites', async () => {
    m.rpc.mockResolvedValue({ data: 'invited', error: null });
    const res = await post({ approve: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'invited',
      invites: expect.objectContaining({ sent: 1 }),
    });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_approve_participant', {
      p_participant_id: 'p-bank',
      p_approve: true,
    });
    expect(m.sendRoomInvites).toHaveBeenCalledWith(m.admin, 'room-1');
  });

  it('rejects without sending anything', async () => {
    m.rpc.mockResolvedValue({ data: 'rejected', error: null });
    expect(await (await post({ approve: false })).json()).toEqual({
      status: 'rejected',
      invites: null,
    });
    expect(m.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('maps 42501 to 403 and a refused state to 409, sending nothing', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message:
          'deal rooms: only a team leader or an admin can approve a participant',
      },
    });
    const res = await post({ approve: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Only a team leader or an admin can approve a participant',
      code: 'forbidden',
    });
    m.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '22023',
        message: 'deal rooms: HSBC officers cannot join',
      },
    });
    expect((await post({ approve: true })).status).toBe(409);
    expect(m.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('wants a boolean', async () => {
    expect((await post({ approve: 'yes' })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
