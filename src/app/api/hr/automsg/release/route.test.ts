import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  drain: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));
vi.mock('@/lib/hr/automsg/drain', () => ({ runHrAutomsgDrain: h.drain }));

import { POST } from './route';

const SUMMARY = { reviewed: 1, expired: 2, outcomes: { sent: 3 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockImplementation(async (min: string) => {
    if (min !== 'admin') throw Object.assign(new Error('min'), { status: 500 });
    return { supabase: {}, accountId: 'acc-1', userId: 'u-1', role: 'admin' };
  });
  h.drain.mockResolvedValue(SUMMARY);
});

describe('POST /api/hr/automsg/release', () => {
  it('runs one drain pass for the caller workspace and answers the summary', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(SUMMARY);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    expect(h.drain).toHaveBeenCalledWith({ accountId: 'acc-1' });
  });

  it('answers 401 without a session and never drains', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('no'), { status: 401 })
    );
    const res = await POST();
    expect(res.status).toBe(401);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('answers 403 below admin and never drains', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('role'), { status: 403 })
    );
    const res = await POST();
    expect(res.status).toBe(403);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('answers 502 failed when the drain returns null', async () => {
    h.drain.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'failed' });
  });
});
