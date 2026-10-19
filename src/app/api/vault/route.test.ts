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

import { GET } from './route';

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

const noStore = (res: Response) =>
  expect(res.headers.get('cache-control')).toBe('no-store');

const OVERVIEW = { bootstrapAvailable: true, myRole: null, roles: [] };

describe('GET /api/vault', () => {
  beforeEach(() => {
    m.vaultOverview.mockResolvedValue(OVERVIEW);
  });

  it('is 403 below admin, without reading the overview', async () => {
    m.ctx.role = 'team_leader';
    const res = await GET();
    expect(res.status).toBe(403);
    noStore(res);
    expect(m.vaultOverview).not.toHaveBeenCalled();
  });

  it('answers configured and the overview read on the service role', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({ configured: true, overview: OVERVIEW });
    expect(m.vaultOverview).toHaveBeenCalledWith(m.admin, 'u-me', 'acct-1');
  });

  it('still answers the overview, with the fixed reason, when not configured', async () => {
    m.vault = { ok: false, reason: 'INVALID_BLIND_KEY' };
    const res = await GET();
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({
      configured: false,
      reason: 'INVALID_BLIND_KEY',
      overview: OVERVIEW,
    });
  });

  it('is a no-store 500 when the overview fails', async () => {
    const { VaultStoreError } = await import('@/lib/vault/store');
    m.vaultOverview.mockImplementation(async () => {
      throw new VaultStoreError('vault_overview', 'XX000');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    noStore(res);
    spy.mockRestore();
  });
});
