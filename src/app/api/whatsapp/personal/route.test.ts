import { beforeEach, describe, expect, it, vi } from 'vitest';

// The self-service personal number routes (migration 190): only someone
// an admin allowed may connect, one number each, and the status and
// disconnect routes answer 404 for anyone else's number.

const h = vi.hoisted(() => ({
  gw: {
    createSession: vi.fn(),
    createScopedKey: vi.fn(),
    createWebhook: vi.fn(),
    startSession: vi.fn(),
    deleteSession: vi.fn(),
    revokeKey: vi.fn(),
    logoutSession: vi.fn(),
    findScopedKeyIds: vi.fn(),
    getSession: vi.fn(),
  },
  role: 'agent',
  profile: null as Record<string, unknown> | null,
  /** What a `whatsapp_config` maybeSingle returns, per filter set. */
  configRow: null as Record<string, unknown> | null,
  importRow: null as Record<string, unknown> | null,
  importEq: [] as unknown[][],
  configEq: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  deletes: 0,
}));

function fakeDb(table: 'profiles' | 'service') {
  return {
    from(name?: string) {
      let op = 'select';
      const b: Record<string, unknown> = {};
      for (const m of ['is', 'order', 'select']) b[m] = () => b;
      b.eq = (...args: unknown[]) => {
        if (name === 'personal_history_imports') h.importEq.push(args);
        else if (table === 'service') h.configEq.push(args);
        return b;
      };
      b.insert = (p: Record<string, unknown>) => {
        op = 'insert';
        h.inserts.push(p);
        return b;
      };
      b.delete = () => {
        op = 'delete';
        h.deletes += 1;
        return b;
      };
      b.update = () => b;
      b.single = async () => ({ data: { id: 'cfg-new' }, error: null });
      b.maybeSingle = async () => ({
        data:
          name === 'personal_history_imports'
            ? h.importRow
            : table === 'profiles'
              ? h.profile
              : h.configRow,
        error: null,
      });
      b.then = (resolve: (r: unknown) => unknown) =>
        resolve({ data: op === 'select' ? [] : null, error: null });
      return b;
    },
  };
}

// The secrets come through the service role (migration 285).
vi.mock('@/lib/whatsapp/channel-secrets', () => ({
  withChannelSecrets: async (rows: Array<{ id: string }>) =>
    rows.map((r) => ({ access_token: 'enc:scoped', app_secret: null, ...r })),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    supabase: fakeDb('profiles'),
    accountId: 'acct-1',
    userId: 'user-1',
    role: h.role,
  }),
  toErrorResponse: () => new Response(null, { status: 401 }),
}));

vi.mock('@/lib/whatsapp/personal-numbers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  personalNumbersAdmin: () => fakeDb('service'),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

vi.mock('@/lib/whatsapp/openwa-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...h.gw,
}));

import { GET, POST } from './route';
import { DELETE } from './[configId]/route';
import { GET as STATUS } from './[configId]/status/route';

function post(body: Record<string, unknown> = {}) {
  return new Request('https://crm.test/api/whatsapp/personal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ configId: 'cfg-9' }) };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('OPENWA_API_KEY', 'admin-key');
  vi.stubEnv('OPENWA_WEBHOOK_BASE_URL', 'http://host.docker.internal:3000');
  for (const fn of Object.values(h.gw)) fn.mockReset();
  h.gw.createSession.mockResolvedValue({ id: 'sess-1', status: 'created' });
  h.gw.createScopedKey.mockResolvedValue({ id: 'key-1', apiKey: 'scoped' });
  h.gw.createWebhook.mockResolvedValue({ id: 'wh-1' });
  h.gw.startSession.mockResolvedValue(undefined);
  h.role = 'agent';
  h.profile = { may_connect_personal_whatsapp: true };
  h.configRow = null;
  h.importRow = null;
  h.importEq = [];
  h.configEq = [];
  h.inserts = [];
  h.deletes = 0;
});

describe('POST /api/whatsapp/personal', () => {
  it('refuses someone an admin has not allowed, touching nothing', async () => {
    h.profile = { may_connect_personal_whatsapp: false };
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_allowed' });
    expect(h.gw.createSession).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('refuses a bank guest even with the flag', async () => {
    h.role = 'bank_guest';
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(h.gw.createSession).not.toHaveBeenCalled();
  });

  it('refuses a second number', async () => {
    h.configRow = { id: 'cfg-old' };
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_connected' });
    expect(h.gw.createSession).not.toHaveBeenCalled();
  });

  it('saves a personal, never-primary number owned by the caller', async () => {
    const res = await POST(post({ label: 'Mine' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configId: 'cfg-new' });
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      provider: 'openwa',
      label: 'Mine',
      is_personal: true,
      is_primary: false,
      phone_number_id: 'sess-1',
      access_token: 'enc:scoped',
    });
  });
});

describe('GET /api/whatsapp/personal', () => {
  it('reports the permission, the gateway and the number', async () => {
    h.configRow = {
      id: 'cfg-9',
      label: 'Mine',
      status: 'connected',
      waba_id: '971500000000',
      connected_at: '2026-11-11T00:00:00Z',
      created_at: '2026-11-10T00:00:00Z',
    };
    const res = await GET();
    expect(await res.json()).toEqual({
      allowed: true,
      configured: true,
      import: null,
      number: {
        id: 'cfg-9',
        label: 'Mine',
        status: 'connected',
        phone: '971500000000',
        connected_at: '2026-11-11T00:00:00Z',
        created_at: '2026-11-10T00:00:00Z',
      },
    });
  });

  it("reports the number's import progress, read by its config id", async () => {
    h.configRow = { id: 'cfg-9', status: 'connected' };
    h.importRow = {
      status: 'running',
      chats_done: 3,
      chats_total: 10,
      messages_imported: 120,
      last_error: null,
      finished_at: null,
    };
    const body = await (await GET()).json();
    expect(body.import).toEqual({
      status: 'running',
      chats_done: 3,
      chats_total: 10,
      messages_imported: 120,
      last_error: null,
      finished_at: null,
    });
    expect(h.importEq).toEqual([['config_id', 'cfg-9']]);
  });

  it('reads no import when the caller has no number', async () => {
    h.importRow = { status: 'done' };
    const body = await (await GET()).json();
    expect(body.import).toBeNull();
    expect(h.importEq).toEqual([]);
  });
});

describe('personal [configId] routes', () => {
  it('404 someone else’s number, asking only for the caller’s own', async () => {
    const del = await DELETE(new Request('https://crm.test'), params);
    expect(del.status).toBe(404);
    const st = await STATUS(new Request('https://crm.test'), params);
    expect(st.status).toBe(404);
    expect(h.deletes).toBe(0);
    expect(h.gw.logoutSession).not.toHaveBeenCalled();
    expect(h.configEq).toEqual(
      expect.arrayContaining([
        ['account_id', 'acct-1'],
        ['is_personal', true],
        ['user_id', 'user-1'],
        ['id', 'cfg-9'],
      ])
    );
  });

  it('disconnects the caller’s own number', async () => {
    h.configRow = { id: 'cfg-9', phone_number_id: 'sess-1' };
    h.gw.logoutSession.mockResolvedValue(undefined);
    h.gw.deleteSession.mockResolvedValue(undefined);
    h.gw.findScopedKeyIds.mockResolvedValue([]);
    const res = await DELETE(new Request('https://crm.test'), params);
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(1);
  });
});
