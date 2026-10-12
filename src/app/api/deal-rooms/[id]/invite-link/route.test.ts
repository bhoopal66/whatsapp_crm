import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  admin: null as unknown,
  getInviteLink: vi.fn(),
  resetInviteLink: vi.fn(),
  removeParticipants: vi.fn(),
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
  getInviteLink: m.getInviteLink,
  resetInviteLink: m.resetInviteLink,
  removeParticipants: m.removeParticipants,
}));
vi.mock('@/lib/deal-rooms/shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { POST as remove } from '../participants/[pid]/remove/route';
import { POST as reset } from './reset/route';
import { GET } from './route';

let mem: ReturnType<typeof memoryDb>;
const ctx = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ id: 'room-1', pid: '', ...extra }),
});
const req = () => new Request('http://localhost/x', { method: 'POST' });

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
    deal_room_participants: [
      { id: 'p-biz', room_id: 'room-1', role: 'business', status: 'joined' },
      {
        id: 'p-1',
        room_id: 'room-1',
        role: 'partner',
        status: 'joined',
        wa_id: '971500000001',
        phone: '971500000001',
      },
      {
        id: 'p-2',
        room_id: 'room-1',
        role: 'customer',
        status: 'invited',
        phone: '971500000002',
      },
    ],
  });
  m.admin = mem.db;
  m.requireRole.mockResolvedValue({
    supabase: { rpc: m.rpc },
    userId: 'user-1',
  });
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.getInviteLink.mockResolvedValue({
    inviteLink: 'https://chat.whatsapp.com/A',
  });
  m.resetInviteLink.mockResolvedValue({
    inviteLink: 'https://chat.whatsapp.com/B',
  });
  m.removeParticipants.mockResolvedValue(undefined);
});

describe('invite link routes', () => {
  it('GET hands a manager the live link, uncached, and stores nothing', async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      inviteLink: 'https://chat.whatsapp.com/A',
    });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_manage', {
      p_room: 'room-1',
    });
    expect(mem.tables.deal_rooms[0].invite_link_hash).toBeUndefined();
  });

  it('POST reset stores only the new hash and audits the reset', async () => {
    const res = await reset(req(), ctx());
    expect(await res.json()).toEqual({
      inviteLink: 'https://chat.whatsapp.com/B',
    });
    expect(mem.tables.deal_rooms[0].invite_link_hash).toBe(
      createHash('sha256').update('https://chat.whatsapp.com/B').digest('hex')
    );
    expect(mem.tables.deal_room_audit).toEqual([
      expect.objectContaining({
        action: 'invite_link_reset',
        actor_id: 'user-1',
      }),
    ]);
  });

  it('answers 403 to a non-manager on all three routes, touching WhatsApp never', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    expect((await GET(req(), ctx())).status).toBe(403);
    expect((await reset(req(), ctx())).status).toBe(403);
    expect((await remove(req(), ctx({ pid: 'p-1' }))).status).toBe(403);
    expect(m.getInviteLink).not.toHaveBeenCalled();
    expect(m.resetInviteLink).not.toHaveBeenCalled();
    expect(m.removeParticipants).not.toHaveBeenCalled();
  });
});

describe('POST /api/deal-rooms/[id]/participants/[pid]/remove', () => {
  it('removes a joined person, records it and warns that the link will not let them back', async () => {
    const res = await remove(req(), ctx({ pid: 'p-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      participantId: 'p-1',
      warning: 'A removed person cannot rejoin through the invite link.',
    });
    expect(m.removeParticipants).toHaveBeenCalledWith({
      groupId: 'grp-1',
      accessToken: 'tok',
      participants: ['971500000001'],
    });
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_participant_event',
      {
        p_account: 'acct-1',
        p_group_id: 'grp-1',
        p_wa_id: '971500000001',
        p_event: 'removed',
      },
    ]);
  });

  it('refuses the business number and someone not in the group', async () => {
    expect((await remove(req(), ctx({ pid: 'p-biz' }))).status).toBe(409);
    expect((await remove(req(), ctx({ pid: 'p-2' }))).status).toBe(409);
    expect((await remove(req(), ctx({ pid: 'nobody' }))).status).toBe(404);
    expect(m.removeParticipants).not.toHaveBeenCalled();
  });
});
