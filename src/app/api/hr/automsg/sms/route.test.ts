import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));

import { GET } from './route';

const SMS_VARS = [
  'DINSTAR_BASE_URL',
  'DINSTAR_USERNAME',
  'DINSTAR_PASSWORD',
  'DINSTAR_PORTS',
  'DINSTAR_TLS_FINGERPRINT',
  'DINSTAR_MAX_PER_MINUTE',
  'SMS_WEBHOOK_SECRET',
  'SMS_WORKSPACE_ID',
  'SMS_ALLOW_QUERY_TOKEN',
  'SMS_WEBHOOK_ALLOW_IPS',
];

const setSending = () => {
  vi.stubEnv('DINSTAR_BASE_URL', 'https://dinstar.example.test');
  vi.stubEnv('DINSTAR_USERNAME', 'gw-user-name');
  vi.stubEnv('DINSTAR_PASSWORD', 'pw-secret-value');
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of SMS_VARS) vi.stubEnv(k, '');
  h.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acc-1',
    userId: 'u-1',
    role: 'viewer',
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/hr/automsg/sms', () => {
  it('answers 401 signed out', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('no'), { status: 401 })
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('asks for a staff role', async () => {
    await GET();
    expect(h.requireRole).toHaveBeenCalledWith('viewer');
  });

  it('reports both off when nothing is set', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      connected: false,
      webhook: false,
    });
  });

  it('reports the flags from the environment and never a value', async () => {
    setSending();
    vi.stubEnv('SMS_WEBHOOK_SECRET', 'whsec-0123456789abcdef');
    vi.stubEnv('SMS_WORKSPACE_ID', '11111111-2222-3333-4444-555555555555');
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ connected: true, webhook: true });
    for (const v of [
      'dinstar.example.test',
      'gw-user',
      'pw-secret',
      'whsec',
      '11111111',
    ]) {
      expect(text).not.toContain(v);
    }
  });

  it('reports only sending when only sending is set', async () => {
    setSending();
    const res = await GET();
    await expect(res.json()).resolves.toEqual({
      connected: true,
      webhook: false,
    });
  });
});
