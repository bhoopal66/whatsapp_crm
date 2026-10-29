import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  available: vi.fn(),
  settings: vi.fn(),
  intentMatch: vi.fn(),
  layer: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: mocks.available,
  getInsightSettings: mocks.settings,
}));

vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: mocks.layer,
}));

import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit';
import { POST } from './route';

const VALID = {
  description: 'wants a card machine for their shop',
  examples: ['  do you have POS terminals? '],
  sensitivity: 'balanced',
  message: 'I need a swipe machine for my store',
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/insights/meaning-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.requireRole
    .mockReset()
    .mockResolvedValue({ accountId: 'account-1', userId: 'user-1' });
  mocks.available.mockReset().mockReturnValue(true);
  mocks.settings
    .mockReset()
    .mockResolvedValue({ meaningTriggersEnabled: true });
  mocks.intentMatch
    .mockReset()
    .mockResolvedValue({ ok: true, p: [0.82], latencyMs: 40 });
  mocks.layer.mockReset().mockReturnValue({ intentMatch: mocks.intentMatch });
});

describe('POST /api/insights/meaning-test', () => {
  it('requires an admin, like the flow and automation save routes', async () => {
    mocks.requireRole.mockRejectedValue(new Error('agent'));
    const res = await post(VALID);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(403);
    expect(mocks.intentMatch).not.toHaveBeenCalled();
  });

  it('judges one candidate with no recent turns and answers a match', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      p: 0.82,
      threshold: 0.75,
      matches: true,
    });
    expect(mocks.intentMatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      message: 'I need a swipe machine for my store',
      recentTurns: [],
      candidates: [
        {
          description: 'wants a card machine for their shop',
          examples: ['do you have POS terminals?'],
        },
      ],
    });
  });

  it('measures against the sensitivity threshold', async () => {
    const res = await post({ ...VALID, sensitivity: 'strict' });
    expect(await res.json()).toEqual({
      p: 0.82,
      threshold: 0.85,
      matches: false,
    });
  });

  it.each([
    ['no body', 'not json'],
    ['no message', { ...VALID, message: '  ' }],
    ['a long message', { ...VALID, message: 'x'.repeat(1001) }],
    ['a short description', { ...VALID, description: 'short' }],
    ['six examples', { ...VALID, examples: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['a bad sensitivity', { ...VALID, sensitivity: 'medium' }],
  ])('is 400 on %s, before asking Jev', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mocks.intentMatch).not.toHaveBeenCalled();
  });

  it('answers the validation issues with field names', async () => {
    const res = await post({ ...VALID, description: 'short' });
    const json = await res.json();
    expect(json.issues).toEqual([
      expect.objectContaining({ field: 'description' }),
    ]);
  });

  it('is 409 unavailable when Jev cannot run for the account', async () => {
    mocks.available.mockReturnValue(false);
    const res = await post(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('unavailable');
    expect(mocks.available).toHaveBeenCalledWith('account-1');
    expect(mocks.intentMatch).not.toHaveBeenCalled();
  });

  it('is 409 off when meaning triggers are switched off', async () => {
    mocks.settings.mockResolvedValue({ meaningTriggersEnabled: false });
    const res = await post(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('off');
    expect(mocks.settings).toHaveBeenCalledWith('account-1');
    expect(mocks.intentMatch).not.toHaveBeenCalled();
  });

  it('is 502 when the judgment fails', async () => {
    mocks.intentMatch.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 2000,
    });
    const res = await post(VALID);
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe('error');
  });

  it('rate-limits per person', async () => {
    const { limit } = RATE_LIMITS.meaningTestUser;
    for (let i = 0; i < limit; i++) {
      expect((await post(VALID)).status).toBe(200);
    }
    const res = await post(VALID);
    expect(res.status).toBe(429);
    expect(mocks.intentMatch).toHaveBeenCalledTimes(limit);
    // Another person has their own bucket.
    mocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      userId: 'user-2',
    });
    expect((await post(VALID)).status).toBe(200);
  });
});
