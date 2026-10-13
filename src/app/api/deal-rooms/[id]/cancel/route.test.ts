import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';

const m = vi.hoisted(() => ({
  canManage: vi.fn(),
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: { rpc: m.canManage },
    userId: 'tl-1',
  }),
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));

import { POST } from './route';

let mem: ReturnType<typeof memoryDb>;
let answer: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  m.canManage.mockResolvedValue({ data: true, error: null });
  answer = 'cancelled';
  mem = memoryDb({}, { rpc: () => answer });
  m.admin = mem.db;
});

const call = (body?: unknown) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );

describe('POST /api/deal-rooms/[id]/cancel', () => {
  it('refuses someone who does not manage the room, before any write', async () => {
    m.canManage.mockResolvedValue({ data: false, error: null });
    const res = await call({ reason: 'wrong customer' });
    expect(res.status).toBe(403);
    expect(m.canManage).toHaveBeenCalledWith('deal_room_can_manage', {
      p_room: 'room-1',
    });
    expect(mem.rpcCalls).toEqual([]);
  });

  it('cancels as the service role, naming the manager and the reason', async () => {
    const res = await call({ reason: ' wrong customer ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'failed' });
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_cancel_creation',
        {
          p_room: 'room-1',
          p_actor: 'tl-1',
          p_reason: 'Cancelled: wrong customer',
        },
      ],
    ]);
  });

  it('stores a plain note without a reason, and refuses a reason that is not text', async () => {
    await call();
    expect(mem.rpcCalls[0][1].p_reason).toBe(
      'Cancelled before WhatsApp created the group'
    );
    expect((await call({ reason: 5 })).status).toBe(400);
  });

  it('answers 409 with the status once the group exists', async () => {
    answer = 'open';
    const res = await call({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'room_not_creating',
      status: 'open',
    });
  });
});
