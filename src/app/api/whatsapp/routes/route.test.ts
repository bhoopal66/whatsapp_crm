import { beforeEach, describe, expect, it, vi } from 'vitest';

// Migration 190 refuses a personal number as the default or a route
// target (SQLSTATE 22023, HINT PERSONAL_NUMBER); the route turns that
// into a 409 the admin can read instead of a bare 500.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  upsert: vi.fn(),
  clear: vi.fn(),
  /** Every write, in order. */
  writes: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadChannels: async () => [
    { id: 'cfg-1', isPersonal: false },
    { id: 'cfg-personal', isPersonal: true },
  ],
}));

import { PUT } from './route';

const refused = {
  code: '22023',
  hint: 'PERSONAL_NUMBER',
  message: 'a personal number cannot be a route',
};

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function useDb() {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.writes.length = 0;
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.clear.mockResolvedValue({ error: null });
  mocks.requireRole.mockResolvedValue({
    accountId: 'account-1',
    supabase: {
      rpc: (...args: unknown[]) => {
        mocks.writes.push('primary');
        return mocks.rpc(...args);
      },
      from: () => ({
        upsert: (...args: unknown[]) => {
          mocks.writes.push('set');
          return mocks.upsert(...args);
        },
        delete: () => ({
          eq: () => ({
            in: (...args: unknown[]) => {
              mocks.writes.push('clear');
              return mocks.clear(...args);
            },
          }),
        }),
      }),
    },
  });
}

describe('PUT /api/whatsapp/routes — personal numbers (190)', () => {
  beforeEach(useDb);

  it('answers 409 when set_primary_channel refuses a personal number', async () => {
    mocks.rpc.mockResolvedValue({ error: refused });
    const res = await PUT(request({ primary_config_id: 'cfg-1' }));
    expect(res.status).toBe(409);
  });

  it('answers 409 when the routes upsert refuses a personal number', async () => {
    mocks.upsert.mockResolvedValue({ error: refused });
    const res = await PUT(request({ routes: { broadcast: 'cfg-1' } }));
    expect(res.status).toBe(409);
  });
});

describe('PUT /api/whatsapp/routes — nothing is half-saved', () => {
  beforeEach(useDb);

  it.each([
    ['an unknown surface', { nope: 'cfg-1' }, 400],
    ['a number that is gone', { broadcast: 'cfg-dead' }, 400],
    ['a personal number', { broadcast: 'cfg-personal' }, 409],
  ])('writes nothing when the body names %s', async (_n, routes, status) => {
    const res = await PUT(
      request({
        primary_config_id: 'cfg-1',
        routes: { inbox: null, ...routes },
      })
    );
    expect(res.status).toBe(status);
    expect(mocks.writes).toEqual([]);
  });

  it('refuses a personal default before any write', async () => {
    const res = await PUT(
      request({
        primary_config_id: 'cfg-personal',
        routes: { broadcast: 'cfg-1' },
      })
    );
    expect(res.status).toBe(409);
    expect(mocks.writes).toEqual([]);
  });

  it('clears nothing when the upsert is refused', async () => {
    mocks.upsert.mockResolvedValue({ error: refused });
    const res = await PUT(
      request({
        primary_config_id: 'cfg-1',
        routes: { inbox: null, broadcast: 'cfg-1' },
      })
    );
    expect(res.status).toBe(409);
    expect(mocks.writes).toEqual(['set']);
  });

  it('says which part was saved when a later write fails', async () => {
    mocks.clear.mockResolvedValue({ error: { message: 'connection reset' } });
    const res = await PUT(
      request({
        primary_config_id: 'cfg-1',
        routes: { inbox: null, broadcast: 'cfg-1' },
      })
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; saved: string[] };
    expect(body.error).toContain('Only a part was saved');
    expect(body.saved).toEqual(['the chosen numbers', 'the default number']);
  });

  it('saves all three', async () => {
    const res = await PUT(
      request({
        primary_config_id: 'cfg-1',
        routes: { inbox: null, broadcast: 'cfg-1' },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, updated: 2 });
  });
});
