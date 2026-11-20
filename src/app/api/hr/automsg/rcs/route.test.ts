import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));

import { GET } from './route';

const RCS_VARS = [
  'RCS_BASE_URL',
  'RCS_TOKEN',
  'RCS_SENDER_ID',
  'RCS_WEBHOOK_SECRET',
  'RCS_WORKSPACE_ID',
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of RCS_VARS) vi.stubEnv(k, '');
  h.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acc-1',
    userId: 'u-1',
    role: 'viewer',
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/hr/automsg/rcs', () => {
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
    vi.stubEnv('RCS_BASE_URL', 'https://rcs.example.test');
    vi.stubEnv('RCS_TOKEN', 'tok-secret-value');
    vi.stubEnv('RCS_SENDER_ID', 'sender-1');
    vi.stubEnv('RCS_WEBHOOK_SECRET', 'whsec-0123456789abcdef');
    vi.stubEnv('RCS_WORKSPACE_ID', '11111111-2222-3333-4444-555555555555');
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ connected: true, webhook: true });
    for (const v of [
      'rcs.example.test',
      'tok-secret',
      'sender-1',
      'whsec',
      '11111111',
    ]) {
      expect(text).not.toContain(v);
    }
  });

  it('reports only sending when only sending is set', async () => {
    vi.stubEnv('RCS_BASE_URL', 'https://rcs.example.test');
    vi.stubEnv('RCS_TOKEN', 'tok');
    vi.stubEnv('RCS_SENDER_ID', 'sender-1');
    const res = await GET();
    await expect(res.json()).resolves.toEqual({
      connected: true,
      webhook: false,
    });
  });
});
