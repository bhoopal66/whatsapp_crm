import { beforeEach, describe, expect, it, vi } from 'vitest';

// The whole team form is ONE update_team call (migration 071), so a
// refusal changes nothing. A malformed body is refused before the RPC;
// the RPC's refusals map onto status codes by SQLSTATE and hint.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { PATCH } from './route';

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

const params = { params: Promise.resolve({ id: 'team-a' }) };

describe('PATCH /api/account/teams/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc, from: mocks.from },
      accountId: 'account-1',
    });
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it('saves every field in one update_team call', async () => {
    const res = await PATCH(
      request({
        name: '  Sales ',
        leader_user_id: 'lee',
        member_ids: ['ana', 'bo', 'ana', 7],
        channel_ids: ['cfg-1', 'cfg-2', 'cfg-1'],
      }),
      params
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('update_team', {
      p_team_id: 'team-a',
      p_name: 'Sales',
      p_set_leader: true,
      p_leader_user_id: 'lee',
      p_member_ids: ['ana', 'bo'],
      p_config_ids: ['cfg-1', 'cfg-2'],
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('leaves absent fields alone (NULL) and does not touch the leader', async () => {
    await PATCH(request({ name: 'Sales' }), params);
    expect(mocks.rpc).toHaveBeenCalledWith('update_team', {
      p_team_id: 'team-a',
      p_name: 'Sales',
      p_set_leader: false,
      p_leader_user_id: null,
      p_member_ids: null,
      p_config_ids: null,
    });
  });

  it('clears the leader with leader_user_id: null, and empties lists with []', async () => {
    await PATCH(
      request({ leader_user_id: null, member_ids: [], channel_ids: [] }),
      params
    );
    expect(mocks.rpc).toHaveBeenCalledWith('update_team', {
      p_team_id: 'team-a',
      p_name: null,
      p_set_leader: true,
      p_leader_user_id: null,
      p_member_ids: [],
      p_config_ids: [],
    });
  });

  it('refuses a malformed body before calling the RPC', async () => {
    const cases: Array<[unknown, string]> = [
      [
        { name: 'Sales', channel_ids: [1] },
        'channel_ids must be an array of ids',
      ],
      [{ name: '   ' }, 'A team name is required'],
      [{ name: 'x'.repeat(61) }, 'Team name must be 60 characters or fewer'],
    ];
    for (const [body, error] of cases) {
      const res = await PATCH(request(body), params);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC refusals by code and hint', async () => {
    const other =
      'Someone you selected is already in another team. A person can only belong to one team.';
    const cases: Array<[string, string | undefined, number, string]> = [
      ['P0002', undefined, 404, 'Team not found'],
      ['23505', 'team_name_taken', 409, 'A team with that name already exists'],
      ['23505', 'member_in_other_team', 409, other],
      // The 044 index itself, reached without the RPC's hint.
      ['23505', undefined, 409, other],
      [
        '22023',
        'member_not_in_account',
        400,
        'Every team member must be a member of this account',
      ],
      [
        '22023',
        'leader_not_in_account',
        400,
        'The team leader must be a member of this account',
      ],
      [
        '22023',
        'number_not_in_account',
        400,
        'Every WhatsApp number must belong to this account',
      ],
      ['22023', undefined, 400, 'Failed to save the team'],
      ['XX000', undefined, 500, 'Failed to save the team'],
    ];
    for (const [code, hint, status, error] of cases) {
      mocks.rpc.mockResolvedValueOnce({ error: { code, hint, message: 'x' } });
      const res = await PATCH(request({ member_ids: ['ana'] }), params);
      expect(res.status, `${code}/${hint}`).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });
});
