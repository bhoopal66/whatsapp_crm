import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { YeastarError } from '@/lib/pbx/yeastar';
import { PbxConnectionError } from '@/lib/pbx/connection';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  db: null as unknown,
  pbxApiFor: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.db,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: mocks.pbxApiFor,
}));

import { GET, PUT } from './route';
import { POST as TEST } from './test/route';

const SECRET = 'very-secret-client-secret';
let fake: FakeDb;

function seed() {
  fake = createFakeDb({
    pbx_connections: [
      {
        id: 'c1',
        account_id: 'acct-1',
        label: 'Main',
        edition: 'cloud',
        base_url: 'https://pbx.example.com',
        api_path: 'openapi/v1.0',
        client_id_last4: 'd123',
        status: 'unknown',
        webhook_path_token: 'a'.repeat(64),
        created_at: '1',
        updated_at: '1',
      },
    ],
    pbx_connection_secrets: [
      {
        connection_id: 'c1',
        client_id_enc: encrypt('client-id123'),
        client_secret_enc: encrypt(SECRET),
        token_cache_enc: 'cached',
        token_cache_updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    pbx_extensions: [
      { connection_id: 'c1', user_id: 'u1', softphone_enabled: true },
      { connection_id: 'c1', user_id: 'u2', softphone_enabled: false },
      { connection_id: 'c1', user_id: null, softphone_enabled: false },
    ],
  });
  mocks.db = fake.db;
}

const put = (body: unknown) =>
  PUT(
    new Request('https://crm.example.com/api/pbx/connection', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
const get = () =>
  GET(new Request('https://crm.example.com/api/pbx/connection'));
const VALID = {
  label: 'Main',
  edition: 'cloud',
  baseUrl: 'https://pbx.example.com',
  clientId: 'client-id123',
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  mocks.requireRole.mockResolvedValue({
    accountId: 'acct-1',
    userId: 'admin-1',
    role: 'admin',
  });
  seed();
});

describe('GET /api/pbx/connection', () => {
  it('requires an admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await get()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('returns the non-secret view and never a secret', async () => {
    const res = await get();
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('client-id123');
    expect(raw).not.toContain('_enc');
    expect(JSON.parse(raw).connection).toMatchObject({
      clientIdLast4: 'd123',
      hasClientSecret: true,
      hasSdkCredentials: false,
      webhookUrl: `https://crm.example.com/api/pbx/yeastar/events/${'a'.repeat(64)}`,
      mappedExtensions: 2,
      softphoneUsers: 1,
    });
  });

  it('states the event path, the latest backfill and the API tokens held', async () => {
    Object.assign(fake.tables.pbx_connections[0], {
      last_event_at: '2026-10-12T09:59:00.000Z',
      last_event_via: 'gateway',
      last_backfill_at: '2026-10-12T08:00:00.000Z',
      last_backfill: { records: 4, ingested: 3, duplicates: 1, failed: 0 },
    });
    const live = {
      accessToken: 'tok',
      accessTokenExpiresAt: Date.now() + 600_000,
      refreshToken: 'ref',
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    };
    const secrets = fake.tables.pbx_connection_secrets[0];
    secrets.token_cache_enc = encrypt(JSON.stringify(live));
    const view = async () => (await (await get()).json()).connection;
    expect(await view()).toMatchObject({
      lastEventVia: 'gateway',
      lastBackfillAt: '2026-10-12T08:00:00.000Z',
      lastBackfill: { records: 4, ingested: 3 },
      apiTokensHeld: 1,
    });
    // An expired (or invalidated) token is not a session held.
    secrets.token_cache_enc = encrypt(
      JSON.stringify({ ...live, accessTokenExpiresAt: 0 })
    );
    expect((await view()).apiTokensHeld).toBe(0);
    secrets.token_cache_enc = null;
    expect((await view()).apiTokensHeld).toBe(0);
  });

  it('answers null for a workspace without a PBX', async () => {
    mocks.requireRole.mockResolvedValue({
      accountId: 'acct-2',
      userId: 'x',
      role: 'admin',
    });
    expect(await (await get()).json()).toEqual({ connection: null });
  });
});

describe('PUT /api/pbx/connection', () => {
  it('validates the body', async () => {
    expect(
      (await put({ ...VALID, baseUrl: 'http://pbx.example.com' })).status
    ).toBe(400);
    expect((await put({ ...VALID, edition: 'cloudy' })).status).toBe(400);
    expect((await put({ ...VALID, sdkAccessId: 5 })).status).toBe(400);
    mocks.requireRole.mockResolvedValue({
      accountId: 'acct-2',
      userId: 'x',
      role: 'admin',
    });
    expect((await put(VALID)).status).toBe(400); // a new connection needs the secret
  });

  it('creates a connection with encrypted secrets and returns none of them', async () => {
    mocks.requireRole.mockResolvedValue({
      accountId: 'acct-2',
      userId: 'admin-2',
      role: 'admin',
    });
    const res = await put({
      ...VALID,
      edition: 'appliance',
      baseUrl: 'http://10.0.0.5:8088/x',
      clientSecret: 'new-secret-value',
      webhookSecret: 'w'.repeat(32),
    });
    const raw = await res.text();
    expect(res.status).toBe(200);
    expect(raw).not.toContain('new-secret-value');
    const row = fake.tables.pbx_connections.find(
      (c) => c.account_id === 'acct-2'
    )!;
    expect(row).toMatchObject({
      base_url: 'http://10.0.0.5:8088',
      created_by: 'admin-2',
    });
    expect(String(row.webhook_path_token)).toMatch(/^[0-9a-f]{64}$/);
    const s = fake.tables.pbx_connection_secrets.find(
      (r) => r.connection_id === row.id
    )!;
    expect(decrypt(String(s.client_secret_enc))).toBe('new-secret-value');
    expect(JSON.parse(raw).connection.hasWebhookSecret).toBe(true);
  });

  it('keeps an omitted secret and the token cache when nothing changed', async () => {
    expect((await put({ ...VALID, label: 'Renamed' })).status).toBe(200);
    const s = fake.tables.pbx_connection_secrets[0];
    expect(decrypt(String(s.client_secret_enc))).toBe(SECRET);
    expect(s.token_cache_enc).toBe('cached');
    expect(fake.tables.pbx_connections[0].label).toBe('Renamed');
  });

  it('keeps the stored Client ID when clientId is omitted; a new connection needs one', async () => {
    const noId = {
      label: 'Renamed',
      edition: VALID.edition,
      baseUrl: VALID.baseUrl,
    };
    expect((await put(noId)).status).toBe(200);
    const s = fake.tables.pbx_connection_secrets[0];
    expect(decrypt(String(s.client_id_enc))).toBe('client-id123');
    expect(s.token_cache_enc).toBe('cached');
    expect(fake.tables.pbx_connections[0]).toMatchObject({
      label: 'Renamed',
      client_id_last4: 'd123',
    });
    expect((await put({ ...noId, clientId: '  ' })).status).toBe(400);
    mocks.requireRole.mockResolvedValue({
      accountId: 'acct-2',
      userId: 'x',
      role: 'admin',
    });
    expect((await put({ ...noId, clientSecret: 'a-secret' })).status).toBe(400);
  });

  it('empties the token caches and the backoff when credentials change', async () => {
    fake.tables.pbx_connection_secrets[0].backoff_until =
      '2099-01-01T00:00:00Z';
    await put({ ...VALID, clientId: 'other-id' });
    const s = fake.tables.pbx_connection_secrets[0];
    expect(s.token_cache_enc).toBeNull();
    expect(s.token_cache_updated_at).not.toBe('2026-01-01T00:00:00.000Z');
    expect(s.backoff_until).toBeNull();
    expect(decrypt(String(s.client_secret_enc))).toBe(SECRET);
    expect(fake.tables.pbx_connections[0]).toMatchObject({
      client_id_last4: 'r-id',
      status: 'unknown',
    });
  });
});

describe('POST /api/pbx/connection/test', () => {
  const api = (impl: () => Promise<unknown>) =>
    mocks.pbxApiFor.mockResolvedValue({ api: { testConnection: vi.fn(impl) } });

  it('records connected', async () => {
    api(async () => ({ ok: true, extensionCount: 12 }));
    const res = await TEST();
    expect(await res.json()).toEqual({
      status: 'connected',
      lastError: null,
      extensionCount: 12,
    });
    expect(fake.tables.pbx_connections[0].status).toBe('connected');
  });

  it('records auth_failed once, without retrying, and backs every process off', async () => {
    const testConnection = vi.fn(async () => {
      throw new YeastarError({
        endpoint: 'get_token',
        errcode: -1,
        errmsg: 'FAILURE',
      });
    });
    mocks.pbxApiFor.mockResolvedValue({ api: { testConnection } });
    const body = await (await TEST()).json();
    expect(body.status).toBe('auth_failed');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(fake.tables.pbx_connections[0].status).toBe('auth_failed');
    expect(
      Date.parse(String(fake.tables.pbx_connection_secrets[0].backoff_until))
    ).toBeGreaterThan(Date.now());
  });

  it('records disconnected for a transport failure', async () => {
    api(async () => {
      throw new YeastarError({
        endpoint: 'extension/list',
        errcode: null,
        errmsg: 'NETWORK ERROR',
      });
    });
    expect((await (await TEST()).json()).status).toBe('disconnected');
  });

  it('answers 429 while backing off, 404 without a connection', async () => {
    mocks.pbxApiFor.mockRejectedValue(
      new PbxConnectionError('auth_backoff', 'x')
    );
    expect((await TEST()).status).toBe(429);
    mocks.requireRole.mockResolvedValue({
      accountId: 'acct-2',
      userId: 'x',
      role: 'admin',
    });
    expect((await TEST()).status).toBe(404);
  });
});
