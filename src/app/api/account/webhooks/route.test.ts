import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings → API keys lists the account's webhooks and switches one off
// or deletes it (315). The stored rows are real here: every filter the
// routes send is applied, so a dropped account filter shows a foreign row.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () =>
    Response.json({ error: 'Too many' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

import { DELETE, PATCH } from './[id]/route';
import { GET } from './route';

type Row = Record<string, unknown>;

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let tables: Record<string, Row[]>;
let failing: string | null;
const selects: Record<string, string> = {};

function from(table: string) {
  let rows = tables[table];
  let change: Row | 'delete' | null = null;
  const answer = () => {
    if (failing === table) return { data: null, error: { code: 'XX000' } };
    if (change === 'delete')
      tables[table] = tables[table].filter((r) => !rows.includes(r));
    else if (change) rows.forEach((r) => Object.assign(r, change));
    return { data: rows, error: null };
  };
  const q = {
    select: (columns: string) => {
      selects[table] = columns;
      return q;
    },
    update: (values: Row) => ((change = values), q),
    delete: () => ((change = 'delete'), q),
    eq: (column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value);
      return q;
    },
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[column]));
      return q;
    },
    order: () => q,
    maybeSingle: async () => {
      const { data, error } = answer();
      return { data: data?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => void) => resolve(answer()),
  };
  return q;
}

const endpoint = (over: Row): Row => ({
  id: OWN,
  account_id: 'acc-1',
  url: 'https://user:pw@hooks.example.com:8443/t0ken/path?key=s3cret',
  secret: 'encrypted-secret',
  events: ['message.received'],
  is_active: true,
  last_delivery_at: '2026-11-24T08:00:00Z',
  failure_count: 0,
  first_failure_at: null,
  created_at: '2026-11-01T08:00:00Z',
  api_key_id: null,
  ...over,
});
const apiKey = (over: Row): Row => ({
  account_id: 'acc-1',
  name: 'Zapier',
  key_hash: 'hash',
  revoked_at: null,
  expires_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  failing = null;
  tables = {
    webhook_endpoints: [
      endpoint({}),
      endpoint({ id: OTHER, account_id: 'acc-2' }),
    ],
    api_keys: [],
  };
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.requireRole.mockResolvedValue({
    supabase: { from },
    accountId: 'acc-1',
    userId: 'user-1',
  });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH({ json: async () => body } as unknown as Request, params(id));
const remove = (id: string) => DELETE({} as Request, params(id));
const row = (id: string) =>
  tables.webhook_endpoints.find((r) => r.id === id) as Row;

describe('GET /api/account/webhooks', () => {
  it('is admin+', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Forbidden'));
    expect((await GET()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it("answers this account's endpoints: the host only, never the secret", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      webhooks: [
        {
          id: OWN,
          host: 'hooks.example.com:8443',
          events: ['message.received'],
          is_active: true,
          last_delivery_at: '2026-11-24T08:00:00Z',
          failure_count: 0,
          first_failure_at: null,
          created_at: '2026-11-01T08:00:00Z',
          key: null,
        },
      ],
    });
    expect(selects.webhook_endpoints).not.toMatch(/secret|\*/);
  });

  it('an unreadable stored URL has no host and is not echoed', async () => {
    tables.webhook_endpoints = [endpoint({ url: 'not a url t0ken' })];
    const body = JSON.stringify(await (await GET()).json());
    expect(body).toContain('"host":null');
    expect(body).not.toContain('t0ken');
  });

  it("names each endpoint's key and whether it is revoked or expired", async () => {
    tables.api_keys = [
      apiKey({ id: 'k-live', expires_at: '2999-01-01T00:00:00Z' }),
      apiKey({ id: 'k-revoked', revoked_at: '2026-11-20T00:00:00Z' }),
      apiKey({ id: 'k-expired', expires_at: '2020-01-01T00:00:00Z' }),
      apiKey({ id: 'k-foreign', account_id: 'acc-2', name: 'Theirs' }),
    ];
    tables.webhook_endpoints = [
      'k-live',
      'k-revoked',
      'k-expired',
      'k-foreign',
      'k-gone',
    ].map((k) => endpoint({ id: `w-${k}`, api_key_id: k }));
    const { webhooks } = await (await GET()).json();
    expect(webhooks.map((w: Row) => w.key)).toEqual([
      { id: 'k-live', name: 'Zapier', status: 'active' },
      { id: 'k-revoked', name: 'Zapier', status: 'revoked' },
      { id: 'k-expired', name: 'Zapier', status: 'expired' },
      null,
      null,
    ]);
    expect(JSON.stringify(webhooks)).not.toContain('hash');
  });

  it.each(['webhook_endpoints', 'api_keys'])(
    'a failed read of %s is an error, never a list',
    async (table) => {
      tables.webhook_endpoints = [endpoint({ api_key_id: 'k-1' })];
      failing = table;
      const res = await GET();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to load webhooks' });
    }
  );
});

describe('PATCH /api/account/webhooks/[id]', () => {
  it('is admin+, and a refused caller writes nothing', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Forbidden'));
    expect((await patch(OWN, { is_active: false })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(row(OWN).is_active).toBe(true);
  });

  it('switches an endpoint off', async () => {
    expect((await patch(OWN, { is_active: false })).status).toBe(200);
    expect(row(OWN).is_active).toBe(false);
  });

  it('refuses to switch one on, and says where that is done', async () => {
    tables.webhook_endpoints = [endpoint({ is_active: false })];
    const res = await patch(OWN, { is_active: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/through the API/);
    expect(row(OWN).is_active).toBe(false);
  });

  it.each([
    null,
    [],
    'off',
    {},
    { is_active: 'false' },
    { is_active: null },
    { is_active: false, url: 'https://elsewhere.example.com' },
    { url: 'https://elsewhere.example.com' },
  ])('400 for %j, and nothing is written', async (body) => {
    const before = { ...row(OWN) };
    expect((await patch(OWN, body)).status).toBe(400);
    expect(row(OWN)).toEqual(before);
  });

  it('404 for a foreign, unknown or malformed id', async () => {
    for (const id of [OTHER, OWN.replace(/1/g, '3'), 'abc']) {
      expect((await patch(id, { is_active: false })).status).toBe(404);
    }
    expect(row(OTHER).is_active).toBe(true);
  });

  it('500 when the write fails; 429 over the limit', async () => {
    failing = 'webhook_endpoints';
    expect((await patch(OWN, { is_active: false })).status).toBe(500);
    mocks.checkRateLimit.mockReturnValue({ success: false });
    expect((await patch(OWN, { is_active: false })).status).toBe(429);
  });
});

describe('DELETE /api/account/webhooks/[id]', () => {
  it('is admin+, and a refused caller deletes nothing', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Forbidden'));
    expect((await remove(OWN)).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(row(OWN)).toBeDefined();
  });

  it('removes one endpoint', async () => {
    expect((await remove(OWN)).status).toBe(200);
    expect(tables.webhook_endpoints.map((r) => r.id)).toEqual([OTHER]);
  });

  it('404 for a foreign, unknown or malformed id', async () => {
    for (const id of [OTHER, OWN.replace(/1/g, '3'), 'abc']) {
      expect((await remove(id)).status).toBe(404);
    }
    expect(tables.webhook_endpoints).toHaveLength(2);
  });

  it('500 when the delete fails; 429 over the limit', async () => {
    failing = 'webhook_endpoints';
    expect((await remove(OWN)).status).toBe(500);
    mocks.checkRateLimit.mockReturnValue({ success: false });
    expect((await remove(OWN)).status).toBe(429);
  });
});
