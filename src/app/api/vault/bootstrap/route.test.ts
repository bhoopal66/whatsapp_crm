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

describe('POST /api/vault/bootstrap', () => {
  it('is 403 below admin and for an admin who is not the owner', async () => {
    for (const role of ['agent', 'admin']) {
      m.ctx.role = role;
      const res = await POST();
      expect(res.status).toBe(403);
      noStore(res);
    }
    expect(m.store.bootstrap).not.toHaveBeenCalled();
  });

  it('bootstraps the owner as themselves', async () => {
    m.ctx.role = 'owner';
    const res = await POST();
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({ status: 'OK' });
    expect(m.store.bootstrap).toHaveBeenCalledWith('u-me', 'acct-1', 'u-me');
  });

  it('is 409 BOOTSTRAP_DENIED once a role exists', async () => {
    m.ctx.role = 'owner';
    m.store.bootstrap.mockResolvedValue('DENIED');
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'BOOTSTRAP_DENIED' });
  });

  it('is 503 VAULT_NOT_CONFIGURED without keys', async () => {
    m.ctx.role = 'owner';
    m.vault = NOT_CONFIGURED;
    const res = await POST();
    expect(res.status).toBe(503);
    noStore(res);
    expect(await res.json()).toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
  });
});
