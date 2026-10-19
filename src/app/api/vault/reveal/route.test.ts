import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ctx: { userId: 'u-me', accountId: 'acct-1', role: 'admin' } as {
    userId: string;
    accountId: string;
    role: string;
  },
  vault: { ok: true, store: {} } as Record<string, unknown>,
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  admin: { admin: true },
  vaultOverview: vi.fn(),
  vaultAuditList: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    getCurrentAccount: async () => m.ctx,
    requireRole: async (min: Parameters<typeof hasMinRole>[1]) => {
      if (!hasMinRole(m.ctx.role as typeof min, min))
        throw new real.ForbiddenError('Insufficient role');
      return m.ctx;
    },
  };
});
vi.mock('@/lib/vault/server', () => ({ vaultStore: () => m.vault }));
vi.mock('@/lib/groups/server', () => ({ supabaseAdmin: () => m.admin }));
vi.mock('@/lib/vault/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vault/store')>()),
  vaultOverview: m.vaultOverview,
  vaultAuditList: m.vaultAuditList,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  m.ctx = { userId: 'u-me', accountId: 'acct-1', role: 'admin' };
  m.store = {
    reveal: vi.fn(async () => ({
      ok: true,
      kind: 'EID',
      value: '784199076543212',
    })),
    delete: vi.fn(async () => 'OK'),
    bootstrap: vi.fn(async () => 'OK'),
    grant: vi.fn(async () => 'OK'),
    revoke: vi.fn(async () => 'OK'),
  };
  m.vault = { ok: true, store: m.store };
});

const NOT_CONFIGURED = { ok: false, reason: 'NOT_CONFIGURED' };
const noStore = (res: Response) =>
  expect(res.headers.get('cache-control')).toBe('no-store');

const TOKEN = 'vlt_' + 'ghjkmnpqrstvwxyz'.repeat(2).slice(0, 26);
const REASON = 'Customer asked to confirm their file';
const post = (body: unknown) =>
  POST(
    new Request('http://x/api/vault/reveal', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

describe('POST /api/vault/reveal', () => {
  it('is 403 below admin, without revealing', async () => {
    for (const role of ['agent', 'team_leader', 'viewer']) {
      m.ctx.role = role;
      const res = await post({ token: TOKEN, reason: REASON });
      expect(res.status).toBe(403);
      noStore(res);
    }
    expect(m.store.reveal).not.toHaveBeenCalled();
  });

  it('reveals with no-store, and never echoes the reason', async () => {
    const res = await post({ token: TOKEN, reason: REASON });
    expect(res.status).toBe(200);
    noStore(res);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ kind: 'EID', value: '784199076543212' });
    expect(text).not.toContain(REASON);
    expect(m.store.reveal).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      TOKEN,
      REASON
    );
  });

  it.each([
    ['DENIED', 403],
    ['NOT_FOUND', 404],
    ['RATE_LIMITED', 429],
    ['DECRYPT_FAILED', 409],
  ] as const)('maps %s to %i with its code', async (status, http) => {
    m.store.reveal.mockResolvedValue({ ok: false, status });
    const res = await post({ token: TOKEN, reason: REASON });
    expect(res.status).toBe(http);
    noStore(res);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: status });
    expect(text).not.toContain(REASON);
    expect(text).not.toContain(TOKEN);
  });

  it('is 400 for a bad token or reason, without revealing', async () => {
    for (const body of [
      { token: 'vlt_abc', reason: REASON },
      { token: TOKEN.toUpperCase(), reason: REASON },
      { token: TOKEN },
      { token: TOKEN, reason: '   ' },
      { token: TOKEN, reason: 'x'.repeat(501) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      noStore(res);
    }
    expect(m.store.reveal).not.toHaveBeenCalled();
    expect((await post({ token: TOKEN, reason: 'x'.repeat(500) })).status).toBe(
      200
    );
  });

  it('is 503 VAULT_NOT_CONFIGURED without keys', async () => {
    m.vault = NOT_CONFIGURED;
    const res = await post({ token: TOKEN, reason: REASON });
    expect(res.status).toBe(503);
    noStore(res);
    expect(await res.json()).toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
  });
});
