import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: ctx.client,
    accountId: 'acc-1',
    userId: 'u-1',
  }),
  getCurrentAccount: async () => ({
    supabase: ctx.client,
    accountId: 'acc-1',
  }),
  assertSalesAccess: (x: unknown) => x,
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: {},
}));
const checks = vi.hoisted(() => ({ during: () => {} }));
vi.mock('@/lib/ai/validate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/validate')>()),
  validateAiCredentials: async () => checks.during(),
}));

import { encrypt } from '@/lib/whatsapp/encryption';
import { settingsTable } from '@/test/settings-table';
import { GET, POST } from './route';

const STORED = {
  id: 'c-1',
  provider: 'openai',
  model: 'gpt-x',
  system_prompt: 'theirs',
  api_key: encrypt('sk-1'),
  updated_at: 'v2',
};
// A model change, so the save checks the key with the provider first.
const BODY = { provider: 'openai', model: 'gpt-y', system_prompt: 'mine' };

const save = (extra: object) =>
  POST(
    new Request('http://x/api/ai/config', {
      method: 'POST',
      body: JSON.stringify({ ...BODY, api_key: 'sk-2', ...extra }),
    })
  );

beforeEach(() => {
  checks.during = () => {};
});

describe('the AI configuration save is version-checked', () => {
  it('GET says which version it read', async () => {
    ctx.client = settingsTable(STORED).client;
    expect(await (await GET()).json()).toMatchObject({
      configured: true,
      updated_at: 'v2',
    });
  });

  it('saves over the version it was loaded from, and answers the new one', async () => {
    const { table, client } = settingsTable(STORED);
    ctx.client = client;
    const res = await save({ expectedUpdatedAt: 'v2' });
    expect(res.status).toBe(200);
    expect(table.row?.system_prompt).toBe('mine');
    expect((await res.json()).updated_at).toBe(table.row?.updated_at);
  });

  it.each([
    ['an older version', 'v1'],
    ['a form that found no configuration', null],
  ])('%s answers 409 and writes nothing', async (_name, expected) => {
    const { table, client } = settingsTable(STORED);
    ctx.client = client;
    const res = await save({ expectedUpdatedAt: expected });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE');
    expect(table.writes).toEqual([]);
  });

  it('a save made while the key is being checked is not overwritten', async () => {
    const { table, client } = settingsTable(STORED);
    ctx.client = client;
    checks.during = () => {
      table.row = { ...STORED, system_prompt: 'newer', updated_at: 'v3' };
    };
    const res = await save({ expectedUpdatedAt: 'v2' });
    expect(res.status).toBe(409);
    expect(table.row?.system_prompt).toBe('newer');
  });

  it('an older client that sends no version still saves', async () => {
    const { table, client } = settingsTable(STORED);
    ctx.client = client;
    expect((await save({})).status).toBe(200);
    expect(table.row?.system_prompt).toBe('mine');
  });

  it('the first save still creates the configuration', async () => {
    const { table, client } = settingsTable(null);
    ctx.client = client;
    expect((await save({ expectedUpdatedAt: null })).status).toBe(200);
    expect(table.row?.system_prompt).toBe('mine');
  });
});
