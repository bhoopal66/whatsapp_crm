import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@/lib/pbx/__tests__/fake-db';
import { PbxConnectionError } from '@/lib/pbx/connection';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  sdkSignerFor: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', () => ({ pbxServiceDb: () => 'service-db' }));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  sdkSignerFor: mocks.sdkSignerFor,
}));

import { POST } from './route';

const sign = vi.fn();
const getUser = vi.fn();
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
  sign.mockResolvedValue('signed-for-201');
  getUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'agent@acme.ae' } },
    error: null,
  });
  // A signer as connection.ts builds it: the decrypted SDK credentials
  // stay inside; `connection` is the non-secret part.
  mocks.sdkSignerFor.mockResolvedValue({
    connection: { id: 'conn-1', baseUrl: 'https://acme.ras.yeastar.com/' },
    sign,
    sdkAccessId: 'SDK-ACCESS-ID',
    sdkAccessKey: 'SDK-ACCESS-KEY',
  });
  mocks.requireRole.mockResolvedValue({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'agent',
    supabase: { ...rls.db, auth: { getUser } },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/pbx/softphone/signature', () => {
  it('needs an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await POST()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('signs the caller’s own extension and returns nothing secret', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      username: '201',
      sign: 'signed-for-201',
      pbxUrl: 'https://acme.ras.yeastar.com',
    });
    expect(text).not.toMatch(/SDK-ACCESS/);
    expect(mocks.sdkSignerFor).toHaveBeenCalledWith('service-db', 'conn-1');
    expect(sign).toHaveBeenCalledWith('201');
  });

  it('is refused while the softphone is off for the extension', async () => {
    mine[0].softphone_enabled = false;
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('softphone_disabled');
    expect(mocks.sdkSignerFor).not.toHaveBeenCalled();
  });

  it('is refused without an extension', async () => {
    mine = [];
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_extension');
    expect(mocks.sdkSignerFor).not.toHaveBeenCalled();
  });

  it('is refused when the PBX has no SDK credentials', async () => {
    mocks.sdkSignerFor.mockRejectedValue(
      new PbxConnectionError('no_sdk_credentials', 'conn-1 has no AccessKey')
    );
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The softphone is not set up on this phone system',
      code: 'no_sdk_credentials',
    });
  });

  it('signs the login email with PBX_SDK_USERNAME_MODE=email', async () => {
    vi.stubEnv('PBX_SDK_USERNAME_MODE', 'email');
    const res = await POST();
    expect((await res.json()).username).toBe('agent@acme.ae');
    expect(sign).toHaveBeenCalledWith('agent@acme.ae');
    getUser.mockResolvedValue({ data: { user: { id: 'u' } }, error: null });
    const none = await POST();
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe('no_email');
  });
});
