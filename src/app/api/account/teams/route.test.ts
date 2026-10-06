import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each team carries the WhatsApp numbers allocated to it (migration
// 071). Read all-or-nothing, like the numbers list: a missing
// allocation list would read as "no numbers".

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

type Result = { data?: unknown; error?: unknown };

function query(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (r: Result) => unknown) =>
    Promise.resolve({ data: null, error: null, ...result }).then(resolve);
  return builder;
}

function ctx(tables: Record<string, Result>) {
  return {
    supabase: { from: (table: string) => query(tables[table] ?? { data: [] }) },
    accountId: 'account-1',
  };
}

describe('GET /api/account/teams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('folds each team its allocated numbers', async () => {
    mocks.requireRole.mockResolvedValue(
      ctx({
        teams: {
          data: [
            { id: 'team-a', name: 'A', leader_user_id: null, created_at: '' },
            { id: 'team-b', name: 'B', leader_user_id: 'lee', created_at: '' },
          ],
        },
        team_members: { data: [{ team_id: 'team-a', user_id: 'ana' }] },
        whatsapp_channel_teams: {
          data: [
            { team_id: 'team-a', config_id: 'cfg-1' },
            { team_id: 'team-a', config_id: 'cfg-2' },
          ],
        },
      })
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const { teams } = await res.json();
    expect(teams[0]).toMatchObject({
      id: 'team-a',
      member_ids: ['ana'],
      channel_ids: ['cfg-1', 'cfg-2'],
    });
    expect(teams[1]).toMatchObject({ id: 'team-b', channel_ids: [] });
  });

  it('fails the whole list when the allocations cannot be read', async () => {
    mocks.requireRole.mockResolvedValue(
      ctx({ whatsapp_channel_teams: { error: { message: 'boom' } } })
    );
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
