import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  sendRoomInvites: vi.fn(),
  admin: { service: true },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: m.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Internal server error' }, { status: 500 })
  ),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/deal-rooms/invites', () => ({
  sendRoomInvites: m.sendRoomInvites,
}));

import { POST } from './route';

const SUMMARY = {
  sent: 2,
  failed: 0,
  skipped: 1,
  notOpen: false,
  templateMissing: false,
};

const post = () =>
  POST(new Request('http://localhost/api/deal-rooms/room-1/invites'), {
    params: Promise.resolve({ id: 'room-1' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireRole.mockResolvedValue({
    supabase: { rpc: m.rpc },
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'agent',
  });
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.sendRoomInvites.mockResolvedValue(SUMMARY);
});

describe('POST /api/deal-rooms/[id]/invites', () => {
  it('sends on the service role once the caller may manage the room: 200 with the summary', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
    expect(m.requireRole).toHaveBeenCalledWith('agent');
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_manage', {
      p_room: 'room-1',
    });
    expect(m.sendRoomInvites).toHaveBeenCalledWith(m.admin, 'room-1');
  });

  it('answers 403 to someone who cannot manage the room, and sends nothing', async () => {
    for (const answer of [
      { data: false, error: null },
      { data: null, error: { message: 'invalid input syntax for type uuid' } },
    ]) {
      m.rpc.mockResolvedValueOnce(answer);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post()).status).toBe(403);
      log.mockRestore();
    }
    expect(m.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('answers 409 while the group does not exist yet', async () => {
    m.sendRoomInvites.mockResolvedValue({ ...SUMMARY, sent: 0, notOpen: true });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The group is not created yet' });
  });

  it('answers 409 when no invite template is configured', async () => {
    m.sendRoomInvites.mockResolvedValue({
      ...SUMMARY,
      sent: 0,
      templateMissing: true,
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Invite template not configured',
    });
  });

  it('answers 500 when the send throws', async () => {
    m.sendRoomInvites.mockRejectedValue(new Error('number disconnected'));
    expect((await post()).status).toBe(500);
  });
});
