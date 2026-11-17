import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  result: { data: [] as unknown, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET, POST } from './route';

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit']) {
    b[m] = (...args: unknown[]) => {
      mocks.calls.push([m, ...args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(mocks.result);
  return b;
}

const BLOCK = '3f2c1a9e-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const post = (body: unknown) =>
  new Request('http://localhost/api/team-activity/unlocks', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.requireRole.mockResolvedValue({
    supabase: { from: vi.fn(() => builder()), rpc: mocks.rpc },
  });
});

describe('GET /api/team-activity/unlocks', () => {
  it('needs the agent role', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET();
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
  });

  it('returns newest 200 and marks a lapsed approval expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    mocks.result = {
      data: [
        { id: 'a', status: 'approved', expires_at: past },
        { id: 'b', status: 'approved', expires_at: future },
        { id: 'c', status: 'pending', expires_at: past },
      ],
      error: null,
    };
    const res = await GET();
    const { unlocks } = await res.json();
    expect(unlocks.map((u: { status: string }) => u.status)).toEqual([
      'expired',
      'approved',
      'pending',
    ]);
    expect(mocks.calls).toContainEqual(['limit', 200]);
    expect(mocks.calls).toContainEqual([
      'order',
      'created_at',
      { ascending: false },
    ]);
  });

  it('answers 503 when the table is missing', async () => {
    mocks.result = { data: null, error: { code: 'PGRST205', message: 'x' } };
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('answers 500 on other errors', async () => {
    mocks.result = { data: null, error: { code: 'XX000', message: 'x' } };
    expect((await GET()).status).toBe(500);
  });
});

describe('POST /api/team-activity/unlocks', () => {
  it('needs the agent role', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await POST(post({ blockId: BLOCK, reason: 'needed it' }));
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['no block id', { reason: 'needed it' }],
    ['a non-uuid block id', { blockId: 'x', reason: 'needed it' }],
    ['a reason under 5 characters', { blockId: BLOCK, reason: '  hi  ' }],
    [
      'a reason over 500 characters',
      { blockId: BLOCK, reason: 'x'.repeat(501) },
    ],
    ['a non-string reason', { blockId: BLOCK, reason: 12345 }],
  ])('answers 400 for %s', async (_l, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC with the trimmed reason and returns the id', async () => {
    mocks.rpc.mockResolvedValue({ data: 'u1', error: null });
    const res = await POST(
      post({ blockId: BLOCK, reason: '  customer asked  ' })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u1' });
    expect(mocks.rpc).toHaveBeenCalledWith('team_activity_request_unlock', {
      p_block_id: BLOCK,
      p_reason: 'customer asked',
    });
  });

  it.each([
    [{ code: '42501' }, 403],
    [{ code: 'P0002' }, 404],
    [{ code: '23505' }, 409],
    [{ code: 'P0001', hint: 'already_pending' }, 409],
    [{ code: 'P0001', hint: 'already_decided' }, 409],
    [{ code: '22023' }, 400],
    [{ code: '22P02' }, 400],
    [{ code: 'P0001', hint: 'other' }, 500],
    [{ code: 'XX000' }, 500],
    [{ code: '42883' }, 503],
    [{ code: 'PGRST202' }, 503],
  ])('maps RPC error %j to %i', async (error, status) => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'secret detail', ...error },
    });
    const res = await POST(post({ blockId: BLOCK, reason: 'needed it' }));
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});
