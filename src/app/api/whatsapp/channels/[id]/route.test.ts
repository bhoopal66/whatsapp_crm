import { beforeEach, describe, expect, it, vi } from 'vitest';

// Allocation (migration 071): `member_ids` and `team_ids` go to ONE
// set_channel_access call, each replacing only its own list (an absent
// one is NULL, left alone), so a refusal changes neither. A bad team id
// is refused before anything is written, and the RPC's own refusals map
// onto the route's status codes by SQLSTATE and hint.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { PATCH } from './route';

type Result = { data?: unknown; error?: unknown };

const neqCalls: unknown[][] = [];

function query(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update']) {
    builder[m] = () => builder;
  }
  builder.neq = (...args: unknown[]) => {
    neqCalls.push(args);
    return builder;
  };
  builder.maybeSingle = () =>
    Promise.resolve({ data: null, error: null, ...result });
  builder.then = (resolve: (r: Result) => unknown) =>
    Promise.resolve({ data: null, error: null, ...result }).then(resolve);
  return builder;
}

function ctx(tables: Record<string, Result> = {}) {
  const all: Record<string, Result> = {
    whatsapp_config: { data: { id: 'cfg-1' } },
    profiles: {
      data: [
        { user_id: 'ana', account_role: 'agent' },
        { user_id: 'bo', account_role: 'agent' },
        { user_id: 'gus', account_role: 'bank_guest' },
      ],
    },
    teams: { data: [{ id: 'team-a' }, { id: 'team-b' }] },
    ...tables,
  };
  return {
    supabase: {
      from: (table: string) => query(all[table] ?? { data: [] }),
      rpc: mocks.rpc,
    },
    accountId: 'account-1',
  };
}

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ id: 'cfg-1' }) };

describe('PATCH /api/whatsapp/channels/[id] { team_ids }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    neqCalls.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue(ctx());
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('saves the people and the teams in one call', async () => {
    const res = await PATCH(
      request({ member_ids: ['ana'], team_ids: ['team-a', 'team-a'] }),
      params
    );
    expect(res.status).toBe(200);
    // The roster is filtered on its rows, not in the query: a database
    // without migration 082 rejects the `bank_guest` literal.
    expect(neqCalls).toEqual([]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('set_channel_access', {
      p_config_id: 'cfg-1',
      p_user_ids: ['ana'],
      p_team_ids: ['team-a'],
    });
  });

  it('refuses a bank guest as a number\'s user', async () => {
    // Only staff can be put on a number: the roster the ids are checked
    // against leaves bank guests out.
    const res = await PATCH(request({ member_ids: ['ana', 'gus'] }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'User gus is not a member of this account',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('an empty team list takes every team off the number', async () => {
    const res = await PATCH(request({ team_ids: [] }), params);
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('set_channel_access', {
      p_config_id: 'cfg-1',
      p_user_ids: null,
      p_team_ids: [],
    });
  });

  it('leaves the teams alone when team_ids is absent', async () => {
    await PATCH(request({ member_ids: ['bo'] }), params);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('set_channel_access', {
      p_config_id: 'cfg-1',
      p_user_ids: ['bo'],
      p_team_ids: null,
    });
  });

  it('does not touch access when neither list is sent', async () => {
    const res = await PATCH(request({ label: 'Sales' }), params);
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects a team_ids that is not a list of ids', async () => {
    const res = await PATCH(request({ team_ids: 'team-a' }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'team_ids must be an array of ids',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses another account's team before writing anything", async () => {
    const res = await PATCH(
      request({ member_ids: ['ana'], team_ids: ['team-x'] }),
      params
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Every team allocated must belong to this account',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC refusals by code and hint', async () => {
    const cases: Array<[string, string | undefined, number, string]> = [
      ['P0002', undefined, 404, 'WhatsApp number not found'],
      [
        '22023',
        'member_not_in_account',
        400,
        'Everyone allocated must be a member of this account',
      ],
      [
        '22023',
        'team_not_in_account',
        400,
        'Every team allocated must belong to this account',
      ],
      ['22023', undefined, 400, 'Failed to update who works this number'],
      ['XX000', undefined, 500, 'Failed to update who works this number'],
    ];
    for (const [code, hint, status, error] of cases) {
      mocks.rpc.mockResolvedValueOnce({ error: { code, hint, message: 'x' } });
      const res = await PATCH(
        request({ member_ids: ['ana'], team_ids: ['team-a'] }),
        params
      );
      expect(res.status, `${code}/${hint}`).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });
});
