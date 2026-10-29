import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// judgeMeanings with the settings and the decision layer stubbed at the
// module boundary.

const h = vi.hoisted(() => ({
  available: true,
  enabled: true,
  intentMatch: vi.fn(),
  /** Rows the account-wide candidate loader reads, per table. */
  rows: { flows: [], automations: [] } as Record<
    string,
    Record<string, unknown>[]
  >,
  reads: 0,
}));

vi.mock('./settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => ({ meaningTriggersEnabled: h.enabled }),
}));
vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => ({ intentMatch: h.intentMatch }),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      h.reads += 1;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ data: h.rows[table] ?? [], error: null }),
      };
      return b;
    },
  }),
}));

import {
  __resetMeaningMemo,
  CANDIDATES_TTL_MS,
  judgeMeanings,
  loadMeaningCandidates,
  MEMO_TTL_MS,
} from './meaning';
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

/** A stored row for candidate `key` (`flow:<id>` / `automation:<id>`). */
const row = (
  key: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: key.split(':')[1],
  trigger_config: { description: `Customer means ${key}` },
  updated_at: '2026-01-01T00:00:00Z',
  entry_node_id: 'start',
  ...extra,
});
const asked = (call = 0) =>
  (
    h.intentMatch.mock.calls[call]![0] as {
      candidates: { description: string }[];
    }
  ).candidates.map((c) => c.description.replace('Customer means ', ''));

beforeEach(() => {
  __resetMeaningMemo();
  h.available = true;
  h.enabled = true;
  h.intentMatch.mockReset();
  h.rows = { flows: [], automations: [] };
  h.reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("one request covers both engines' active candidates; the second engine asks nothing", async () => {
    h.rows = { flows: [row('flow:f1')], automations: [row('automation:a1')] };
    answer({ 'flow:f1': 0.5, 'automation:a1': 0.9 });
    const flows = await judgeMeanings({
      ...base,
      candidates: [cand('flow:f1')],
    });
    expect(flows.size).toBe(0);
    const autos = await judgeMeanings({
      ...base,
      candidates: [cand('automation:a1')],
    });
    expect([...autos.entries()]).toEqual([['automation:a1', 0.9]]);
    expect(h.intentMatch).toHaveBeenCalledTimes(1);
    expect(asked().sort()).toEqual(['flow:f1', 'automation:a1'].sort());
  });

  it('a failed request is memoised as no match for every candidate it covered', async () => {
    h.rows = { flows: [row('flow:f1')], automations: [row('automation:a1')] };
    h.intentMatch.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 2000,
    });
    await judgeMeanings({ ...base, candidates: [cand('flow:f1')] });
    const autos = await judgeMeanings({
      ...base,
      candidates: [cand('automation:a1')],
    });
    expect(autos.size).toBe(0);
    expect(h.intentMatch).toHaveBeenCalledTimes(1);
  });

  it('skips stored configs that fail validation, and flows without an entry node', async () => {
    h.rows = {
      flows: [
        row('flow:f1', { trigger_config: { description: '' } }),
        row('flow:f2', { entry_node_id: null }),
        row('flow:f3'),
      ],
      automations: [
        row('automation:a1', { trigger_config: { description: 'short' } }),
      ],
    };
    answer({});
    await judgeMeanings({ ...base, candidates: [cand('x')] });
    expect(asked().sort()).toEqual(['flow:f3', 'x'].sort());
  });

  it('sends at most 20 candidates, flows first then the newest, warning once per hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.rows = {
      flows: [row('flow:f1', { updated_at: '2025-01-01T00:00:00Z' })],
      automations: Array.from({ length: 21 }, (_, i) =>
        row(`automation:a${String(i).padStart(2, '0')}`, {
          updated_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      ),
    };
    answer({ 'automation:a00': 0.99 });
    const r = await judgeMeanings({
      ...base,
      candidates: [cand('automation:a00')],
    });
    // a00 is the oldest automation: left out, so it matches nothing.
    expect(r.size).toBe(0);
    expect(asked()).toHaveLength(20);
    expect(asked()[0]).toBe('flow:f1');
    expect(asked()[1]).toBe('automation:a20');
    expect(asked()).not.toContain('automation:a00');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[insights\]/);
    expect(String(warn.mock.calls[0]![0])).not.toContain('I want a loan');

    await judgeMeanings({
      ...base,
      messageKey: 'wamid.2',
      candidates: [cand('automation:a00')],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('caches the account candidate set for 30 s', async () => {
    vi.useFakeTimers();
    h.rows = { flows: [row('flow:f1')], automations: [] };
    await loadMeaningCandidates('acc-1');
    await loadMeaningCandidates('acc-1');
    expect(h.reads).toBe(2); // flows + automations, once
    vi.advanceTimersByTime(CANDIDATES_TTL_MS);
    await loadMeaningCandidates('acc-1');
    expect(h.reads).toBe(4);
  });

  it('a candidate not in the cached set (just activated) is asked on its own', async () => {
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
