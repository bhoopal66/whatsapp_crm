import { beforeEach, describe, expect, it, vi } from 'vitest';

// The numbers list feeds the access dialog, which saves `member_ids`
// back through set_channel_members — and that RPC replaces the DIRECT
// list only (migration 071). So the split pinned here is load-bearing:
// a person who has the number only through a team must not appear in
// `member_ids`, or the first save after the team is allocated would
// turn them into a hand-ticked member who keeps the number after the
// team is taken off it.

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

type Result = { data?: unknown; error?: unknown; count?: number };

/** A thenable query builder: every chained call returns itself. */
function query(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (r: Result) => unknown) =>
    Promise.resolve({ data: null, error: null, ...result }).then(resolve);
  return builder;
}

function client(tables: Record<string, Result>) {
  return {
    from: (table: string) => query(tables[table] ?? { data: [] }),
  };
}

const CHANNEL = {
  id: 'cfg-1',
  provider: 'whapi',
  label: 'Sales',
  phone_number_id: 'MANTIS-1',
  waba_id: '971500000000',
  is_primary: true,
  status: 'connected',
  registered_at: null,
  created_at: null,
};

function tables(overrides: Record<string, Result> = {}) {
  return {
    whatsapp_config: { data: [CHANNEL, { ...CHANNEL, id: 'cfg-2' }] },
    whatsapp_channel_members: {
      data: [
        { config_id: 'cfg-1', user_id: 'ana', direct: true, via_team: false },
        { config_id: 'cfg-1', user_id: 'bo', direct: false, via_team: true },
        { config_id: 'cfg-1', user_id: 'cy', direct: true, via_team: true },
        // Moved off the account: listed nowhere.
        { config_id: 'cfg-1', user_id: 'gone', direct: true, via_team: true },
      ],
    },
    whatsapp_channel_teams: {
      data: [
        { config_id: 'cfg-1', team_id: 'team-a' },
        { config_id: 'cfg-2', team_id: 'team-b' },
      ],
    },
    profiles: {
      data: [{ user_id: 'ana' }, { user_id: 'bo' }, { user_id: 'cy' }],
    },
    conversations: { count: 3 },
    ...overrides,
  };
}

describe('GET /api/whatsapp/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits direct people from team people, and lists the teams', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: client(tables()),
      accountId: 'account-1',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');

    const [first, second] = body.channels;
    expect(first.member_ids).toEqual(['ana', 'cy']);
    expect(first.team_member_ids).toEqual(['bo', 'cy']);
    expect(first.team_ids).toEqual(['team-a']);
    expect(first.conversation_count).toBe(3);

    expect(second.member_ids).toEqual([]);
    expect(second.team_member_ids).toEqual([]);
    expect(second.team_ids).toEqual(['team-b']);
  });

  it('fails the whole list when the team allocations cannot be read', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.requireRole.mockResolvedValue({
      supabase: client(
        tables({ whatsapp_channel_teams: { error: { message: 'boom' } } })
      ),
      accountId: 'account-1',
    });

    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to load WhatsApp numbers',
    });
    consoleError.mockRestore();
  });
});
