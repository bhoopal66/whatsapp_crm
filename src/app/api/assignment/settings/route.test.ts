import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));

import { GET, PUT } from './route';
import { DELETE, PUT as PUT_LIMIT } from '../limits/[userId]/route';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function supabase() {
  return {
    from: (table: string) => {
      const result = h.tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => result;
      builder.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject);
      return builder;
    },
    rpc: h.rpc,
  };
}

const json = (body: unknown) =>
  new Request('http://localhost/api/assignment/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.tables = {
    assignment_settings: { data: null, error: null },
    profiles: {
      data: [
        {
          user_id: U1,
          full_name: 'Ravi Kumar',
          email: null,
          account_role: 'agent',
          deactivated_at: null,
        },
        {
          user_id: U2,
          full_name: 'Amal',
          email: null,
          account_role: 'team_leader',
          deactivated_at: null,
        },
        {
          user_id: 'g',
          full_name: 'Guest',
          email: null,
          account_role: 'bank_guest',
          deactivated_at: null,
        },
        {
          user_id: 'gone',
          full_name: 'Gone',
          email: null,
          account_role: 'agent',
          deactivated_at: '2026-01-01',
        },
      ],
      error: null,
    },
    assignment_chat_limits: {
      data: [{ user_id: U1, max_open: 12 }],
      error: null,
    },
  };
  h.requireRole.mockImplementation(async (min: string) => {
    if (min !== 'admin') throw Object.assign(new Error('min'), { status: 500 });
    return { supabase: supabase(), accountId: 'acc-1', userId: 'u-1' };
  });
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'assignment_member_loads')
      return {
        data: [{ user_id: U1, open_count: 7, chat_limit: null }],
        error: null,
      };
    if (fn === 'assignment_settings_set')
      return {
        data: {
          broadcast_rotation_enabled: true,
          broadcast_pool: [U1],
          compass_assign_enabled: false,
          limits_enabled: false,
          default_chat_limit: 30,
        },
        error: null,
      };
    return { data: true, error: null };
  });
});

describe('GET /api/assignment/settings', () => {
  it('answers the defaults and live staff with loads and own limits', async () => {
    const res = await GET();
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.settings).toEqual({
      broadcastRotationEnabled: false,
      broadcastPool: [],
      compassAssignEnabled: false,
      limitsEnabled: false,
      defaultChatLimit: 30,
    });
    expect(body.members).toEqual([
      {
        userId: U2,
        name: 'Amal',
        role: 'team_leader',
        deactivated: false,
        openCount: 0,
        limit: null,
      },
      {
        userId: U1,
        name: 'Ravi Kumar',
        role: 'agent',
        deactivated: false,
        openCount: 7,
        limit: 12,
      },
    ]);
  });

  it('answers available: false before migration 236', async () => {
    h.tables.assignment_settings = {
      data: null,
      error: { code: '42P01', message: 'missing' },
    };
    const body = await (await GET()).json();
    expect(body.available).toBe(false);
  });

  it('answers 403 below admin', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('role'), { status: 403 })
    );
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/assignment/settings', () => {
  it('saves only the fields sent', async () => {
    const res = await PUT(
      json({ broadcastRotationEnabled: true, broadcastPool: [U1] })
    );
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('assignment_settings_set', {
      p_broadcast_rotation_enabled: true,
      p_broadcast_pool: [U1],
      p_compass_assign_enabled: null,
      p_limits_enabled: null,
      p_default_chat_limit: null,
    });
    expect((await res.json()).settings.broadcastPool).toEqual([U1]);
  });

  const poolSent = () =>
    h.rpc.mock.calls.map(([, args]) => args.p_broadcast_pool);

  it('applies a pool change to the pool stored now', async () => {
    // Another admin added U2 since this screen loaded [].
    h.tables.assignment_settings = {
      data: { broadcast_pool: [U2] },
      error: null,
    };
    const res = await PUT(
      json({
        broadcastPoolChange: { add: [U1], remove: [], fromEveryone: true },
      })
    );
    expect(res.status).toBe(200);
    expect(poolSent()).toEqual([[U2, U1]]);
  });

  it('refuses a change the stored pool cannot take', async () => {
    h.tables.assignment_settings = {
      data: { broadcast_pool: [U1] },
      error: null,
    };
    const res = await PUT(
      json({
        broadcastPoolChange: { add: [], remove: [U1], fromEveryone: false },
      })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('pool_changed');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('saves nothing when the stored pool cannot be read', async () => {
    const change = { add: [U1], remove: [], fromEveryone: true };
    h.tables.assignment_settings = {
      data: null,
      error: { code: '57014', message: 'timeout' },
    };
    const res = await PUT(json({ broadcastPoolChange: change }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('load_failed');
    h.tables.assignment_settings.error = { code: '42P01', message: 'missing' };
    expect((await PUT(json({ broadcastPoolChange: change }))).status).toBe(503);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('does not read the pool for other fields', async () => {
    h.tables.assignment_settings = {
      data: null,
      error: { code: '57014', message: 'timeout' },
    };
    expect((await PUT(json({ limitsEnabled: true }))).status).toBe(200);
    expect(poolSent()).toEqual([null]);
  });

  it('refuses a bad body before the database', async () => {
    expect((await PUT(json({}))).status).toBe(400);
    for (const broadcastPoolChange of [
      null,
      { add: [U1] },
      { add: ['x'], remove: [], fromEveryone: false },
      { add: [], remove: [], fromEveryone: false },
    ]) {
      expect((await PUT(json({ broadcastPoolChange }))).status).toBe(400);
    }
    expect(
      (
        await PUT(
          json({
            broadcastPool: [U1],
            broadcastPoolChange: { add: [U1], remove: [], fromEveryone: true },
          })
        )
      ).status
    ).toBe(400);
    expect((await PUT(json({ limitsEnabled: 'yes' }))).status).toBe(400);
    expect((await PUT(json({ broadcastPool: ['x'] }))).status).toBe(400);
    const bad = await PUT(json({ defaultChatLimit: 0 }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe('bad_limit');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('words the SQL refusals', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', hint: 'pool_member_invalid', message: 'x' },
    });
    const res = await PUT(json({ broadcastPool: [U2] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('pool_member_invalid');

    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'Only an owner or admin' },
    });
    const denied = await PUT(json({ limitsEnabled: true }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe('not_allowed');
  });
});

describe('/api/assignment/limits/[userId]', () => {
  const put = (userId: string, body: unknown) =>
    PUT_LIMIT(
      new Request('http://localhost/x', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
      params(userId)
    );

  it('sets a person’s own limit', async () => {
    const res = await put(U1, { maxOpen: 20 });
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('assignment_chat_limit_set', {
      p_user_id: U1,
      p_max_open: 20,
    });
  });

  it('removes it on DELETE', async () => {
    const res = await DELETE(new Request('http://localhost/x'), params(U1));
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('assignment_chat_limit_set', {
      p_user_id: U1,
      p_max_open: null,
    });
  });

  it('refuses a bad limit or id before the database', async () => {
    expect((await put(U1, { maxOpen: 501 })).status).toBe(422);
    expect((await put('nope', { maxOpen: 5 })).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('words no_such_member', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', hint: 'no_such_member', message: 'x' },
    });
    const res = await put(U2, { maxOpen: 5 });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_such_member');
  });

  it('answers 403 below admin', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('role'), { status: 403 })
    );
    expect((await put(U1, { maxOpen: 5 })).status).toBe(403);
  });
});
