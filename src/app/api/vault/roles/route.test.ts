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

import { DELETE, POST } from './route';

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

const USER = '22222222-2222-4222-8222-222222222222';
const req = (method: string, body: unknown) =>
  new Request('http://x/api/vault/roles', {
    method,
    body: JSON.stringify(body),
  });

describe('/api/vault/roles', () => {
  it('is 403 below admin on both verbs', async () => {
    m.ctx.role = 'agent';
    for (const res of [
      await POST(req('POST', { user_id: USER, role: 'admin' })),
      await DELETE(req('DELETE', { user_id: USER, role: 'admin' })),
    ]) {
      expect(res.status).toBe(403);
      noStore(res);
    }
    expect(m.store.grant).not.toHaveBeenCalled();
    expect(m.store.revoke).not.toHaveBeenCalled();
  });

  it('grants and revokes, passing the status through', async () => {
    let res = await POST(req('POST', { user_id: USER, role: 'super_admin' }));
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({ status: 'OK' });
    expect(m.store.grant).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      USER,
      'super_admin'
    );
    m.store.revoke.mockResolvedValue('NOOP');
    res = await DELETE(req('DELETE', { user_id: USER, role: 'admin' }));
    expect(await res.json()).toEqual({ status: 'NOOP' });
    expect(m.store.revoke).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      USER,
      'admin'
    );
  });

  it('is 409 ROLE_DENIED on a refusal', async () => {
    m.store.grant.mockResolvedValue('DENIED');
    const res = await POST(req('POST', { user_id: USER, role: 'admin' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ROLE_DENIED' });
  });

  it('is 400 for a bad body and 503 when not configured', async () => {
    expect(
      (await POST(req('POST', { user_id: 'x', role: 'admin' }))).status
    ).toBe(400);
    expect(
      (await POST(req('POST', { user_id: USER, role: 'owner' }))).status
    ).toBe(400);
    m.vault = NOT_CONFIGURED;
    const res = await DELETE(req('DELETE', { user_id: USER, role: 'admin' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
    expect(m.store.grant).not.toHaveBeenCalled();
  });
});
