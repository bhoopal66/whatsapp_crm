import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';
import { MetaError } from '@/lib/whatsapp/meta-api';

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  admin: null as unknown,
  sendGroupText: vi.fn(),
  sendGroupTemplate: vi.fn(),
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
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: m.getUser }, rpc: m.rpc }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/whatsapp/meta-groups', async (orig) => ({
  ...(await orig<object>()),
  sendGroupText: m.sendGroupText,
  sendGroupTemplate: m.sendGroupTemplate,
}));
vi.mock('@/lib/deal-rooms/shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { POST } from './route';

const HOUR = 3_600_000;
let mem: ReturnType<typeof memoryDb>;

function seed(windowUntil: string | null, status = 'open') {
  mem = memoryDb(
    {
      deal_rooms: [
        {
          id: 'room-1',
          account_id: 'acct-1',
          status,
          wa_group_id: 'grp-1',
          whatsapp_config_id: 'cfg-1',
          window_until: windowUntil,
        },
      ],
    },
    {
      rpc: (fn) => {
        if (fn === 'deal_room_record_message') return 'gm-1';
        return null;
      },
    }
  );
  m.admin = mem.db;
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/deal-rooms/room-1/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.sendGroupText.mockResolvedValue({ messageId: 'wamid.T' });
  m.sendGroupTemplate.mockResolvedValue({ messageId: 'wamid.P' });
  seed(new Date(Date.now() + HOUR).toISOString());
});

describe('POST /api/deal-rooms/[id]/messages', () => {
  it('sends free text inside the window and records it as the caller', async () => {
    const res = await post({ text: ' Hello all ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'gm-1', waMessageId: 'wamid.T' });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_post', {
      p_room: 'room-1',
    });
    expect(m.sendGroupText).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'grp-1', text: 'Hello all' })
    );
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({
        p_group_id: 'grp-1',
        p_direction: 'out',
        p_type: 'text',
        p_wa_message_id: 'wamid.T',
        p_body: 'Hello all',
        p_staff_user_id: 'user-1',
      }),
    ]);
  });

  it('refuses free text once the window has closed (409 window_closed), sending nothing', async () => {
    for (const until of [new Date(Date.now() - 1000).toISOString(), null]) {
      seed(until);
      const res = await post({ text: 'Hello' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('window_closed');
    }
    expect(m.sendGroupText).not.toHaveBeenCalled();
  });

  it('still sends a template outside the window', async () => {
    seed(new Date(Date.now() - HOUR).toISOString());
    const res = await post({
      templateName: 'deal_update',
      language: 'en',
      params: ['ADCB'],
    });
    expect(res.status).toBe(201);
    expect(m.sendGroupTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'deal_update',
        language: 'en',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'ADCB' }] },
        ],
      })
    );
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({
        p_type: 'template',
        p_template_name: 'deal_update',
      }),
    ]);
  });

  it('lets a bank guest post in their room: the decision is deal_room_can_post, not requireRole', async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'guest-1' } } });
    const res = await post({ text: 'Officer here' });
    expect(res.status).toBe(201);
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({ p_staff_user_id: 'guest-1' }),
    ]);
  });

  it('answers 403 where the caller cannot post (a guest elsewhere), and 401 signed out', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    expect((await post({ text: 'x' })).status).toBe(403);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ text: 'x' })).status).toBe(401);
    expect(m.sendGroupText).not.toHaveBeenCalled();
  });

  it('maps 131020 to 409 group_not_ready and records nothing', async () => {
    m.sendGroupText.mockRejectedValue(new MetaError('not ready', 400, 131020));
    const res = await post({ text: 'Hello' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_not_ready');
    expect(mem.rpcCalls.map(([fn]) => fn)).not.toContain(
      'deal_room_record_message'
    );
  });

  it('marks the room suspended on 131207', async () => {
    m.sendGroupText.mockRejectedValue(new MetaError('suspended', 400, 131207));
    const res = await post({ text: 'Hello' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_suspended');
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_set_status',
      {
        p_room: 'room-1',
        p_status: 'suspended',
        p_reason: 'suspended by WhatsApp',
      },
    ]);
  });

  it('refuses a room that is not open, and a malformed body', async () => {
    seed(new Date(Date.now() + HOUR).toISOString(), 'closing');
    expect((await post({ text: 'Hello' })).status).toBe(409);
    expect((await post({ text: '  ' })).status).toBe(400);
    expect((await post({ text: 'a', templateName: 'b' })).status).toBe(400);
  });
});
