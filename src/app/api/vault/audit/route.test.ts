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

const NOT_CONFIGURED = { ok: false, reason: 'NOT_CONFIGURED' };
const noStore = (res: Response) =>
  expect(res.headers.get('cache-control')).toBe('no-store');

const get = (q = '') => GET(new Request(`http://x/api/vault/audit${q}`));

describe('GET /api/vault/audit', () => {
  beforeEach(() => {
    m.vaultAuditList.mockResolvedValue([{ id: '1' }]);
  });

  it('is 403 below admin, without reading', async () => {
    m.ctx.role = 'viewer';
    const res = await get();
    expect(res.status).toBe(403);
    noStore(res);
    expect(m.vaultAuditList).not.toHaveBeenCalled();
  });

  it('reads the audit on the service role, configured or not', async () => {
    m.vault = NOT_CONFIGURED;
    const res = await get('?limit=20');
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({ rows: [{ id: '1' }] });
    expect(m.vaultAuditList).toHaveBeenCalledWith(
      m.admin,
      'u-me',
      'acct-1',
      20
    );
    await get();
    expect(m.vaultAuditList.mock.calls[1][3]).toBeUndefined();
  });

  it('is 400 for a bad limit', async () => {
    for (const q of ['?limit=0', '?limit=501', '?limit=abc'])
      expect((await get(q)).status).toBe(400);
    expect(m.vaultAuditList).not.toHaveBeenCalled();
  });
});
