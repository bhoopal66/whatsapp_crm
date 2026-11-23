import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: ctx.client,
    accountId: 'acc-1',
    userId: 'u-1',
  }),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: {},
}));

import {
  TEAM_ACTIVITY_DEFAULTS,
  rowFromLimits,
} from '@/lib/team-activity/limits';
import { settingsTable } from '@/test/settings-table';
import { GET, PUT } from './route';

const limits = { ...TEAM_ACTIVITY_DEFAULTS, timezone: 'Asia/Dubai' };
const stored = (dailyNewChatsPerUser: number, updated_at: string) => ({
  ...rowFromLimits('acc-1', { ...limits, dailyNewChatsPerUser }),
  updated_at,
});
const save = (extra: object) =>
  PUT(
    new Request('http://x/api/team-activity/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...limits, dailyNewChatsPerUser: 7, ...extra }),
    })
  );

describe('the Team activity limits are version-checked', () => {
  it('GET answers what is stored with its version', async () => {
    ctx.client = settingsTable(stored(33, 'v2')).client;
    expect(await (await GET()).json()).toMatchObject({
      settings: { dailyNewChatsPerUser: 33, timezone: 'Asia/Dubai' },
      saved: true,
      updatedAt: 'v2',
    });
  });

  it('GET answers the defaults, unsaved, when there is no row', async () => {
    ctx.client = settingsTable(null).client;
    expect(await (await GET()).json()).toMatchObject({
      settings: {
        dailyNewChatsPerUser: TEAM_ACTIVITY_DEFAULTS.dailyNewChatsPerUser,
      },
      saved: false,
      updatedAt: null,
    });
  });

  it('saves over the version it was loaded from', async () => {
    const { table, client } = settingsTable(stored(33, 'v2'));
    ctx.client = client;
    const res = await save({ expectedUpdatedAt: 'v2' });
    expect(res.status).toBe(200);
    expect((await res.json()).limits.dailyNewChatsPerUser).toBe(7);
    expect(table.writes).toHaveLength(1);
  });

  it.each([
    ['an older version', 'v1'],
    ['a form that found no limits', null],
  ])('%s answers 409 and writes nothing', async (_name, expected) => {
    const { table, client } = settingsTable(stored(33, 'v2'));
    ctx.client = client;
    const res = await save({ expectedUpdatedAt: expected });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE');
    expect(table.writes).toEqual([]);
  });

  it('the first save creates the row', async () => {
    const { table, client } = settingsTable(null);
    ctx.client = client;
    expect((await save({ expectedUpdatedAt: null })).status).toBe(200);
    expect(table.writes).toHaveLength(1);
  });

  it('an older client that sends no version still saves', async () => {
    const { table, client } = settingsTable(stored(33, 'v2'));
    ctx.client = client;
    expect((await save({})).status).toBe(200);
    expect(table.writes).toHaveLength(1);
  });
});
