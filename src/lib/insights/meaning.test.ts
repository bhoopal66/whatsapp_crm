import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// judgeMeanings with the settings and the decision layer stubbed at the
// module boundary.

const h = vi.hoisted(() => ({
  available: true,
  enabled: true,
  intentMatch: vi.fn(),
}));

vi.mock('./settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => ({ meaningTriggersEnabled: h.enabled }),
}));
vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => ({ intentMatch: h.intentMatch }),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import { __resetMeaningMemo, judgeMeanings, MEMO_TTL_MS } from './meaning';
import { MEANING_THRESHOLDS, meaningThreshold } from './meaning-config';

const cand = (key: string, threshold = 0.75) => ({
  key,
  description: `Customer means ${key}`,
  threshold,
});
const base = {
  accountId: 'acc-1',
  messageKey: 'wamid.1',
  text: 'I want a loan',
  recentTurns: [],
};

/** Jev answers p by description: `Customer means <key>` → P[key]. */
function answer(P: Record<string, number>) {
  h.intentMatch.mockImplementation(
    async (input: { candidates: { description: string }[] }) => ({
      ok: true,
      latencyMs: 5,
      p: input.candidates.map(
        (c) => P[c.description.replace('Customer means ', '')] ?? 0
      ),
    })
  );
}

beforeEach(() => {
  __resetMeaningMemo();
  h.available = true;
  h.enabled = true;
  h.intentMatch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('judgeMeanings', () => {
  it('returns the candidates at or above their own threshold', async () => {
    answer({ a: 0.75, b: 0.74, c: 0.9 });
    const r = await judgeMeanings({
      ...base,
      candidates: [cand('a'), cand('b'), cand('c', 0.95)],
    });
    expect([...r.entries()]).toEqual([['a', 0.75]]);
  });

  it('asks nothing when Jev is unavailable or meaning triggers are off', async () => {
    answer({ a: 0.9 });
    h.available = false;
    expect(
      (await judgeMeanings({ ...base, candidates: [cand('a')] })).size
    ).toBe(0);
    h.available = true;
    h.enabled = false;
    expect(
      (await judgeMeanings({ ...base, candidates: [cand('a')] })).size
    ).toBe(0);
    expect(h.intentMatch).not.toHaveBeenCalled();
  });

  it('shares one request per message; a later caller asks only missing keys', async () => {
    answer({ a: 0.9, b: 0.8, c: 0.7 });
    await judgeMeanings({ ...base, candidates: [cand('a'), cand('b')] });
    const r = await judgeMeanings({
      ...base,
      candidates: [cand('b'), cand('c', 0.65)],
    });
    expect([...r.entries()]).toEqual([
      ['b', 0.8],
      ['c', 0.7],
    ]);
    expect(h.intentMatch).toHaveBeenCalledTimes(2);
    const second = h.intentMatch.mock.calls[1]![0] as {
      candidates: { description: string }[];
    };
    expect(second.candidates.map((c) => c.description)).toEqual([
      'Customer means c',
    ]);
    // Everything judged: a third caller makes no request at all.
    await judgeMeanings({ ...base, candidates: [cand('a'), cand('c')] });
    expect(h.intentMatch).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers on the same message share the in-flight request', async () => {
    answer({ a: 0.9 });
    const [x, y] = await Promise.all([
      judgeMeanings({ ...base, candidates: [cand('a')] }),
      judgeMeanings({ ...base, candidates: [cand('a')] }),
    ]);
    expect(x.get('a')).toBe(0.9);
    expect(y.get('a')).toBe(0.9);
    expect(h.intentMatch).toHaveBeenCalledTimes(1);
  });

  it('forgets a message after the TTL', async () => {
    vi.useFakeTimers();
    answer({ a: 0.9 });
    await judgeMeanings({ ...base, candidates: [cand('a')] });
    vi.advanceTimersByTime(MEMO_TTL_MS - 1);
    await judgeMeanings({ ...base, candidates: [cand('a')] });
    expect(h.intentMatch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await judgeMeanings({ ...base, candidates: [cand('a')] });
    expect(h.intentMatch).toHaveBeenCalledTimes(2);
  });

  it('keys the memo by account and message', async () => {
    answer({ a: 0.9 });
    await judgeMeanings({ ...base, candidates: [cand('a')] });
    await judgeMeanings({
      ...base,
      messageKey: 'wamid.2',
      candidates: [cand('a')],
    });
    await judgeMeanings({
      ...base,
      accountId: 'acc-2',
      candidates: [cand('a')],
    });
    expect(h.intentMatch).toHaveBeenCalledTimes(3);
  });

  it('a failed request matches nothing, is not retried for the message, and never throws', async () => {
    h.intentMatch.mockResolvedValueOnce({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
      latencyMs: 3,
    });
    expect(
      (await judgeMeanings({ ...base, candidates: [cand('a')] })).size
    ).toBe(0);
    expect(
      (await judgeMeanings({ ...base, candidates: [cand('a')] })).size
    ).toBe(0);
    expect(h.intentMatch).toHaveBeenCalledTimes(1);

    h.intentMatch.mockRejectedValueOnce(new Error('boom'));
    await expect(
      judgeMeanings({ ...base, messageKey: 'wamid.9', candidates: [cand('a')] })
    ).resolves.toEqual(new Map());
  });

  it('loads lazy turns only when it asks', async () => {
    answer({ a: 0.9 });
    const turns = vi.fn(async () => [
      { from: 'business' as const, text: 'Hi' },
    ]);
    h.enabled = false;
    await judgeMeanings({
      ...base,
      recentTurns: turns,
      candidates: [cand('a')],
    });
    expect(turns).not.toHaveBeenCalled();
    h.enabled = true;
    await judgeMeanings({
      ...base,
      recentTurns: turns,
      candidates: [cand('a')],
    });
    expect(turns).toHaveBeenCalledTimes(1);
    expect(h.intentMatch.mock.calls[0]![0]).toMatchObject({
      recentTurns: [{ from: 'business', text: 'Hi' }],
    });
  });
});

describe('meaningThreshold', () => {
  it('maps sensitivity, balanced by default', () => {
    expect(MEANING_THRESHOLDS).toEqual({
      strict: 0.85,
      balanced: 0.75,
      loose: 0.65,
    });
    expect(meaningThreshold('strict')).toBe(0.85);
    expect(meaningThreshold('loose')).toBe(0.65);
    expect(meaningThreshold(undefined)).toBe(0.75);
    expect(meaningThreshold('nonsense')).toBe(0.75);
  });
});
