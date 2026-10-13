import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  admin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: { rpc: m.rpc }, userId: 'tl-1' }),
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
// Adding people runs as the caller: the service role is never reached.
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: m.admin }));

import { POST } from './route';

const A = '00000000-0000-4000-8000-0000000000aa';
const G = '00000000-0000-4000-8000-0000000000cc';

const call = (body?: unknown) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockResolvedValue({ data: 1, error: null });
});

describe('POST /api/deal-rooms/[id]/people', () => {
  it('adds staff as the caller and answers how many were new', async () => {
    m.rpc.mockResolvedValue({ data: 1, error: null });
    const res = await call({ staff: [A, A.toUpperCase()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1 });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_add_staff', {
      p_room: 'room-1',
      p_user_ids: [A],
    });
    expect(m.admin).not.toHaveBeenCalled();
  });

  it('adds a bank guest login as the caller', async () => {
    m.rpc.mockResolvedValue({ data: null, error: null });
    const res = await call({ guest: G });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1 });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_add_guest_user', {
      p_room: 'room-1',
      p_user_id: G,
    });
  });

  it('refuses a body that is neither, before asking the database', async () => {
    for (const body of [
      undefined,
      {},
      { staff: [A], guest: G },
      { staff: ['x'] },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid' });
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("passes the database's refusal on as a code the panel words", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'deal rooms: only a manager of this room can add a bank guest',
      },
    });
    const res = await call({ guest: G });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_manager' });
  });

  it('names the bank when the room has no approved officer of it', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '22023',
        message: 'deal rooms: this room has no approved ADCB participant',
      },
    });
    const res = await call({ guest: G });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'no_bank_participant',
      bank: 'ADCB',
    });
  });

  it('answers 500 on an unexpected database error', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'boom' },
    });
    expect((await call({ staff: [A] })).status).toBe(500);
  });
});
