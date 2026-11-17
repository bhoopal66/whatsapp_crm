import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { POST } from './route';

const ID = '3f2c1a9e-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const call = (body: unknown, id = ID) =>
  POST(
    new Request(`http://localhost/api/team-activity/unlocks/${id}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.requireRole.mockResolvedValue({ supabase: { rpc: mocks.rpc } });
});

describe('POST /api/team-activity/unlocks/[id]', () => {
  it('needs the agent role', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await call({ approve: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['no approve', {}],
    ['a string approve', { approve: 'yes' }],
    ['a non-string note', { approve: true, note: 5 }],
    ['a note over 500 characters', { approve: true, note: 'x'.repeat(501) }],
  ])('answers 400 for %s', async (_l, body) => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 400 for a non-uuid id', async () => {
    expect((await call({ approve: true }, 'abc')).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC and returns the status', async () => {
    mocks.rpc.mockResolvedValue({ data: 'approved', error: null });
    const res = await call({ approve: true, note: ' ok ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'approved' });
    expect(mocks.rpc).toHaveBeenCalledWith('team_activity_decide_unlock', {
      p_id: ID,
      p_approve: true,
      p_note: 'ok',
    });
  });

  it('sends a null note when none is given', async () => {
    mocks.rpc.mockResolvedValue({ data: 'denied', error: null });
    await call({ approve: false });
    expect(mocks.rpc).toHaveBeenCalledWith('team_activity_decide_unlock', {
      p_id: ID,
      p_approve: false,
      p_note: null,
    });
  });

  it.each([
    [{ code: '42501' }, 403],
    [{ code: 'P0002' }, 404],
    [{ code: '23505' }, 409],
    [{ code: 'P0001', hint: 'already_decided' }, 409],
    [{ code: '22023' }, 400],
    [{ code: 'XX000' }, 500],
    [{ code: '42P01' }, 503],
  ])('maps RPC error %j to %i', async (error, status) => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'secret detail', ...error },
    });
    const res = await call({ approve: true });
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});
