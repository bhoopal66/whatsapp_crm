import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    getQr: vi.fn(),
  },
  /** The openwa row the `maybeSingle` read returns. */
  row: null as Record<string, unknown> | null,
  /** Rows left after a delete, for the primary promotion. */
  rest: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  deletes: 0,
  insertError: null as { code: string; message: string } | null,
  siblings: 0,
}));

/** A chainable, awaitable Supabase fake over `whatsapp_config`. */
function fakeDb() {
  return {
    from() {
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ['eq', 'is', 'order', 'select']) b[m] = () => b;
      b.insert = (p: Record<string, unknown>) => {
        op = 'insert';
        payload = p;
        h.inserts.push(p);
        return b;
      };
      b.update = (p: Record<string, unknown>) => {
        op = 'update';
        h.updates.push(p);
        return b;
      };
      b.delete = () => {
        op = 'delete';
        h.deletes += 1;
        return b;
      };
      b.single = async () =>
        h.insertError
          ? { data: null, error: h.insertError }
          : { data: { id: `cfg-${payload.is_primary}` }, error: null };
      b.maybeSingle = async () => ({ data: h.row, error: null });
      b.then = (resolve: (r: unknown) => unknown) =>
        resolve(
          op === 'select'
            ? { data: h.rest, count: h.siblings, error: null }
            : { data: null, error: null }
        );
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
  requireRole: async () => ({
    supabase: fakeDb(),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
  }),
  toErrorResponse: () => new Response(null, { status: 403 }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

// Real OpenWAError, env readers and key naming; gateway calls stubbed.
vi.mock('@/lib/whatsapp/openwa-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...h.gw,
}));

import { OpenWAError } from '@/lib/whatsapp/openwa-api';
import { POST } from './route';
import { DELETE } from './[configId]/route';
import { GET } from './[configId]/status/route';
import { resetOpenWAProbeCache } from '@/lib/whatsapp/openwa-number';

function post(body: Record<string, unknown>) {
  return new Request('https://crm.test/api/whatsapp/config/openwa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ configId: 'cfg-1' }) };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('OPENWA_API_KEY', 'admin-key');
  vi.stubEnv('OPENWA_WEBHOOK_BASE_URL', 'http://host.docker.internal:3000');
  for (const fn of Object.values(h.gw)) fn.mockReset();
  h.gw.createSession.mockResolvedValue({ id: 'sess-1', status: 'created' });
  h.gw.createScopedKey.mockResolvedValue({ id: 'key-1', apiKey: 'scoped' });
  h.gw.createWebhook.mockResolvedValue({ id: 'wh-1' });
  h.gw.startSession.mockResolvedValue(undefined);
  h.gw.deleteSession.mockResolvedValue(undefined);
  h.gw.revokeKey.mockResolvedValue(undefined);
  h.gw.logoutSession.mockResolvedValue(undefined);
  h.gw.findScopedKeyIds.mockResolvedValue(['key-1']);
  h.row = null;
  h.rest = [];
  h.inserts = [];
  h.updates = [];
  h.deletes = 0;
  h.insertError = null;
  h.siblings = 0;
});

describe('POST /api/whatsapp/config/openwa', () => {
  it('answers openwa_not_configured without an admin key', async () => {
    vi.stubEnv('OPENWA_API_KEY', '');
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'openwa_not_configured' });
    expect(h.gw.createSession).not.toHaveBeenCalled();
  });

  it('provisions in order and saves the scoped key, never the admin key', async () => {
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configId: 'cfg-true' });

    expect(h.gw.createScopedKey).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      sessionId: 'sess-1',
    });
    const hook = h.gw.createWebhook.mock.calls[0][0];
    expect(hook.url).toBe(
      'http://host.docker.internal:3000/api/whatsapp/openwa/webhook'
    );
    expect(hook.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.gw.startSession).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      sessionId: 'sess-1',
    });

    expect(h.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      provider: 'openwa',
      label: 'Sales',
      is_primary: true,
      phone_number_id: 'sess-1',
      access_token: 'enc:scoped',
      verify_token: `enc:${hook.secret}`,
      status: 'disconnected',
    });
    expect(JSON.stringify(h.inserts)).not.toContain('admin-key');
  });

  it('is not the primary when the account already has a number', async () => {
    h.siblings = 1;
    await POST(post({ label: 'Second' }));
    expect(h.inserts[0].is_primary).toBe(false);
  });

  it('revokes the key and deletes the session when a later step fails', async () => {
    h.gw.startSession.mockRejectedValue(
      new OpenWAError('Maximum concurrent sessions reached (5)', 400)
    );
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Maximum concurrent sessions');
    expect(h.gw.revokeKey).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      keyId: 'key-1',
    });
    expect(h.gw.deleteSession).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      sessionId: 'sess-1',
    });
    expect(h.inserts).toHaveLength(0);
  });

  it('cleans up the gateway when the row cannot be saved', async () => {
    h.insertError = { code: '42501', message: 'denied' };
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(500);
    expect(h.gw.revokeKey).toHaveBeenCalled();
    expect(h.gw.deleteSession).toHaveBeenCalled();
  });

  it('revokes a key whose mint answer was lost, found by its name', async () => {
    // The mint may have succeeded at the gateway while its answer timed out.
    h.gw.createScopedKey.mockRejectedValue(new OpenWAError('timeout', 503));
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(502);
    expect(h.gw.findScopedKeyIds).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      sessionId: 'sess-1',
    });
    expect(h.gw.revokeKey).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      keyId: 'key-1',
    });
    expect(h.gw.deleteSession).toHaveBeenCalled();
    expect((await res.json()).error).not.toMatch(/may be left/);
  });

  it('does not claim a clean gateway when the cleanup failed', async () => {
    h.insertError = { code: '42501', message: 'denied' };
    h.gw.deleteSession.mockRejectedValue(new OpenWAError('down', 503));
    const res = await POST(post({ label: 'Sales' }));
    const { error } = await res.json();
    expect(error).not.toMatch(/Nothing was left/);
    expect(error).toMatch(/may be left on the OpenWA gateway/);
  });

  it('touches nothing to clean up when the session was never created', async () => {
    h.gw.createSession.mockRejectedValue(new OpenWAError('down', 503));
    const res = await POST(post({ label: 'Sales' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/not reachable/);
    expect(h.gw.deleteSession).not.toHaveBeenCalled();
    expect(h.gw.revokeKey).not.toHaveBeenCalled();
  });
});

describe('GET /api/whatsapp/config/openwa/[configId]/status', () => {
  beforeEach(() => {
    // Each case is a fresh gateway answer, not one inside the probe's
    // shared-read window.
    resetOpenWAProbeCache();
    h.row = {
      id: 'cfg-1',
      phone_number_id: 'sess-1',
      access_token: 'enc:scoped',
      waba_id: null,
      status: 'disconnected',
    };
  });

  it('404s a row outside the account (or not OpenWA)', async () => {
    h.row = null;
    const res = await GET(new Request('https://crm.test/x'), params);
    expect(res.status).toBe(404);
  });

  it('shares one gateway read between polls, but not with ?fresh=1 (the close-check)', async () => {
    h.gw.getSession.mockResolvedValue({ status: 'authenticating' });
    await GET(new Request('https://crm.test/x'), params);
    await GET(new Request('https://crm.test/x'), params);
    expect(h.gw.getSession).toHaveBeenCalledTimes(1);
    const res = await GET(new Request('https://crm.test/x?fresh=1'), params);
    expect(await res.json()).toEqual({ status: 'authenticating' });
    expect(h.gw.getSession).toHaveBeenCalledTimes(2);
  });

  it('returns the QR while waiting for a scan, asking with the scoped key', async () => {
    h.gw.getSession.mockResolvedValue({ status: 'qr_ready', phone: null });
    h.gw.getQr.mockResolvedValue({
      qrCode: 'data:image/png;base64,AAA',
      status: 'qr_ready',
    });
    const res = await GET(new Request('https://crm.test/x'), params);
    expect(await res.json()).toEqual({
      status: 'qr_ready',
      qrCode: 'data:image/png;base64,AAA',
    });
    expect(h.gw.getSession).toHaveBeenCalledWith({
      apiKey: 'scoped',
      sessionId: 'sess-1',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('writes the number and connected once when ready', async () => {
    h.gw.getSession.mockResolvedValue({
      status: 'ready',
      phone: '971500000001',
    });
    const res = await GET(new Request('https://crm.test/x'), params);
    expect(await res.json()).toEqual({
      status: 'ready',
      phone: '971500000001',
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      status: 'connected',
      waba_id: '971500000001',
    });

    h.updates = [];
    h.row = {
      ...h.row,
      status: 'connected',
      waba_id: '971500000001',
      connected_at: '2026-10-28T08:00:00Z',
    };
    await GET(new Request('https://crm.test/x'), params);
    expect(h.updates).toHaveLength(0);
  });

  it('leaves a number that went down to the sweep, still showing it live', async () => {
    // Linked before, marked down by the sweep since. Writing 'connected'
    // here would swallow the sweep's "connected again" alert.
    h.row = {
      ...h.row,
      status: 'disconnected',
      waba_id: '971500000001',
      connected_at: '2026-10-01T08:00:00Z',
    };
    h.gw.getSession.mockResolvedValue({
      status: 'ready',
      phone: '971500000001',
    });
    const res = await GET(new Request('https://crm.test/x'), params);
    expect(await res.json()).toEqual({
      status: 'ready',
      phone: '971500000001',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('stores the phone alone after the first link when the session reports a different one', async () => {
    // A first link the health sweep stamped without a number, then a
    // re-link to another handset: both keep the number following the
    // phone, and neither touches the sweep-owned status.
    for (const waba_id of [null, '971500000001']) {
      resetOpenWAProbeCache(); // two separate scenarios, not one read window
      h.updates = [];
      h.row = {
        ...h.row,
        status: 'connected',
        waba_id,
        connected_at: '2026-10-01T08:00:00Z',
      };
      h.gw.getSession.mockResolvedValue({
        status: 'ready',
        phone: '971500000002',
      });
      await GET(new Request('https://crm.test/x'), params);
      expect(h.updates).toEqual([{ waba_id: '971500000002' }]);
    }
  });
});

describe('DELETE /api/whatsapp/config/openwa/[configId]', () => {
  it('logs out, deletes the session, revokes the key, then the row', async () => {
    h.row = { id: 'cfg-1', phone_number_id: 'sess-1' };
    h.rest = [{ id: 'cfg-2', is_primary: false }];
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect(res.status).toBe(200);
    expect(h.gw.logoutSession).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      sessionId: 'sess-1',
    });
    expect(h.gw.deleteSession).toHaveBeenCalled();
    expect(h.gw.revokeKey).toHaveBeenCalledWith({
      adminKey: 'admin-key',
      keyId: 'key-1',
    });
    expect(h.deletes).toBe(1);
    // The remaining number becomes the primary.
    expect(h.updates).toEqual([{ is_primary: true }]);
    expect(await res.json()).toEqual({ ok: true, gatewayCleanup: 'complete' });
  });

  it('counts a never-started logout and an already-gone session as complete', async () => {
    h.row = { id: 'cfg-1', phone_number_id: 'sess-1' };
    h.gw.logoutSession.mockRejectedValue(new OpenWAError('not started', 400));
    h.gw.deleteSession.mockRejectedValue(new OpenWAError('gone', 404));
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect(await res.json()).toEqual({ ok: true, gatewayCleanup: 'complete' });
  });

  it('still removes the row when the gateway calls fail, and says so', async () => {
    h.row = { id: 'cfg-1', phone_number_id: 'sess-1' };
    h.gw.logoutSession.mockRejectedValue(new OpenWAError('down', 503));
    h.gw.deleteSession.mockRejectedValue(new OpenWAError('down', 503));
    h.gw.findScopedKeyIds.mockRejectedValue(new OpenWAError('down', 503));
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(1);
    expect(await res.json()).toEqual({
      ok: true,
      gatewayCleanup: 'incomplete',
    });
  });

  it('is incomplete when only a key revoke fails', async () => {
    h.row = { id: 'cfg-1', phone_number_id: 'sess-1' };
    h.gw.revokeKey.mockRejectedValue(new OpenWAError('down', 503));
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect((await res.json()).gatewayCleanup).toBe('incomplete');
    expect(h.deletes).toBe(1);
  });

  it('is incomplete without an admin key, the gateway left alone', async () => {
    vi.stubEnv('OPENWA_API_KEY', '');
    h.row = { id: 'cfg-1', phone_number_id: 'sess-1' };
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect((await res.json()).gatewayCleanup).toBe('incomplete');
    expect(h.gw.deleteSession).not.toHaveBeenCalled();
    expect(h.deletes).toBe(1);
  });

  it('is complete for a row that never had a session, the gateway left alone', async () => {
    for (const phone_number_id of ['', null]) {
      h.deletes = 0;
      h.row = { id: 'cfg-1', phone_number_id };
      const res = await DELETE(new Request('https://crm.test/x'), params);
      expect(await res.json()).toEqual({
        ok: true,
        gatewayCleanup: 'complete',
      });
      expect(h.gw.logoutSession).not.toHaveBeenCalled();
      expect(h.gw.deleteSession).not.toHaveBeenCalled();
      expect(h.deletes).toBe(1);
    }
  });

  it('is a no-op for a row it cannot see', async () => {
    const res = await DELETE(new Request('https://crm.test/x'), params);
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(0);
    expect(h.gw.logoutSession).not.toHaveBeenCalled();
  });
});
