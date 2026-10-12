import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.service,
}));

import { GET } from './route';

const SECRETS = {
  connection_id: 'conn-1',
  client_id_enc: 'enc-client-id',
  client_secret_enc: 'enc-client-secret',
  sdk_access_id_enc: 'enc-sdk-id',
  sdk_access_key_enc: 'enc-sdk-key',
  webhook_secret_enc: 'enc-webhook',
  token_cache_enc: 'enc-token',
  sdk_token_cache_enc: 'enc-sdk-token',
};
let service: FakeDb;
let mine: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  mine = [
    { connection_id: 'conn-1', extension: '201', softphone_enabled: true },
  ];
  const rls = createFakeDb(
    {},
    {
      pbx_my_extension: () => ({ data: mine, error: null }),
    }
  );
  service = createFakeDb({
    pbx_connections: [
      { id: 'conn-1', base_url: 'https://acme.ras.yeastar.com/ ' },
    ],
    pbx_connection_secrets: [{ ...SECRETS }],
  });
  mocks.service = service.db;
  mocks.requireRole.mockResolvedValue({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'agent',
    supabase: rls.db,
  });
});

describe('GET /api/pbx/me', () => {
  it('is open to viewers', async () => {
    await GET();
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await GET()).status).toBe(403);
  });

  it('answers extension null without a mapping', async () => {
    mine = [];
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extension: null });
  });

  it('describes the caller’s phone and never a stored secret', async () => {
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      extension: '201',
      connectionId: 'conn-1',
      softphoneEnabled: true,
      softphoneAvailable: true,
      pbxUrl: 'https://acme.ras.yeastar.com',
    });
    for (const secret of Object.values(SECRETS).slice(1))
      expect(text).not.toContain(secret);
  });

  it('says the softphone is unavailable without both SDK credentials', async () => {
    service.tables.pbx_connection_secrets[0].sdk_access_key_enc = null;
    expect((await (await GET()).json()).softphoneAvailable).toBe(false);
    service.tables.pbx_connection_secrets = [];
    expect((await (await GET()).json()).softphoneAvailable).toBe(false);
  });
});
