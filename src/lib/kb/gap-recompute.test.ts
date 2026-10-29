import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from '@/lib/typesafe/test-helpers';

const h = vi.hoisted(() => ({
  db: null as unknown,
  layer: null as unknown,
  loadAiConfig: vi.fn(),
  embedTexts: vi.fn(),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: h.embedTexts }));
vi.mock('@/lib/typesafe', async (orig) => ({
  ...(await orig<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () => h.layer,
}));

import {
  accountsDueForGapRecompute,
  clearKbGapTopics,
  coverageFor,
  recomputeKbGapTopics,
  runKbGapRecomputePass,
} from './gap-recompute';
import { TOPIC_LABEL_MAX } from './gap-topics';

const NOW = new Date('2026-10-29T12:00:00Z');
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const gap = (id: string, question: string, day: number) => ({
  id: `0000000${id}-0000-4000-8000-000000000000`,
  question,
  created_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
});
const GAPS = [
  gap('1', 'how long does account opening take', 20),
  gap('2', 'how long does account opening take', 21),
  gap('3', 'how long does account opening take', 22),
  gap('4', 'pos terminal rental price monthly', 23),
  gap('5', 'pos terminal rental price monthly', 24),
  gap('6', 'gold loan against jewellery', 25),
];
const SHORTLIST = [E1, E2].map((id, i) => ({
  id,
  ref: `R${i}`,
  question: `q${i}`,
  answer_en: `answer ${i}`,
  answer_ar: null,
  handoff_after: false,
  rank: 1 - i / 10,
}));

type RpcError = { message: string; code?: string; hint?: string };
const STALE: RpcError = { message: 'changed', code: '40001', hint: 'STALE' };

function fakeDb(
  opts: {
    gaps?: unknown[];
    topics?: unknown[];
    members?: unknown[];
    replaceError?: RpcError | null;
    /** Per replace call, in order; past the end, replaceError. */
    replaceResults?: (RpcError | null)[];
    /** Called on each replace, before it answers. */
    onReplace?: (tables: Record<string, unknown[]>, call: number) => void;
    /** What the cron's account scan (select 'account_id') reads. */
    scanRows?: unknown[];
  } = {}
) {
  const tables: Record<string, unknown[]> = {
    ai_knowledge_gaps: opts.gaps ?? GAPS,
    kb_gap_topics: opts.topics ?? [],
    kb_gap_topic_members: opts.members ?? [],
  };
  let replaces = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name === 'kb_shortlist') return { data: SHORTLIST, error: null };
    const call = replaces++;
    opts.onReplace?.(tables, call);
    const error =
      call < (opts.replaceResults?.length ?? 0)
        ? opts.replaceResults![call]
        : (opts.replaceError ?? null);
    return { data: 0, error };
  });
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let columns = '';
    for (const m of ['eq', 'gte', 'order', 'limit', 'range']) b[m] = () => b;
    b.select = (cols: string) => {
      columns = cols;
      return b;
    };
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({
        data:
          columns === 'account_id'
            ? (opts.scanRows ?? [])
            : (tables[table] ?? []),
        error: null,
      }).then(ok);
    return b;
  };
  h.db = { from, rpc };
  return rpc;
}

type ReplaceArgs = {
  p_account: string;
  p_topics: Record<string, unknown>[];
  p_expected: Record<string, string>;
};
const allReplaceArgs = (rpc: ReturnType<typeof fakeDb>) =>
  rpc.mock.calls
    .filter((c) => c[0] === 'kb_gap_topics_replace')
    .map((c) => (c as unknown as [string, ReplaceArgs])[1]);

const replaceArgs = (rpc: ReturnType<typeof fakeDb>) => {
  const calls = rpc.mock.calls.filter((c) => c[0] === 'kb_gap_topics_replace');
  expect(calls).toHaveLength(1);
  return (calls[0] as unknown as [string, ReplaceArgs])[1];
};

/** Jev answers by topic: full, partial and none coverage. */
function jev() {
  const sim = makeSim((body) => {
    const q = (body.state as { question: string }).question;
    const level = q.startsWith('how long')
      ? 1.8
      : q.startsWith('pos')
        ? 1.0
        : 0.3;
    return { answers: { intent: 'account_opening', c1: 0.1, c2: level } };
  });
  h.layer = makeLayer({ sim }).layer;
  return sim;
}

beforeEach(() => {
  vi.useRealTimers();
  h.layer = null;
  h.loadAiConfig.mockReset().mockResolvedValue(null);
  h.embedTexts.mockReset();
});

describe('coverageFor', () => {
  it('bands the expected level at 1.6 and 0.8', () => {
    expect(coverageFor(1.6)).toBe('full');
    expect(coverageFor(1.59)).toBe('partial');
    expect(coverageFor(0.8)).toBe('partial');
    expect(coverageFor(0.79)).toBe('none');
  });
});

describe('recomputeKbGapTopics', () => {
  it('groups lexically, judges coverage and replaces once', async () => {
    const rpc = fakeDb();
    const sim = jev();
    const r = await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    expect(r).toEqual({ ok: true, topics: 3, mode: 'lexical', judged: 3 });
    const { p_account, p_topics } = replaceArgs(rpc);
    expect(p_account).toBe(TEST_ACCOUNT);
    const byLabel = Object.fromEntries(p_topics.map((t) => [t.label, t]));
    expect(byLabel['how long does account opening take']).toEqual({
      label: 'how long does account opening take',
      intent: 'account_opening',
      question_count: 3,
      first_seen_at: '2026-10-20T10:00:00Z',
      last_seen_at: '2026-10-22T10:00:00Z',
      coverage: 'full',
      covered_by_entry_id: E2,
      coverage_p: 0.9,
      status: 'open',
      dismissed_at: null,
      gap_ids: [GAPS[2]!.id, GAPS[1]!.id, GAPS[0]!.id],
    });
    expect(byLabel['pos terminal rental price monthly']).toMatchObject({
      coverage: 'partial',
      covered_by_entry_id: E2,
      coverage_p: 0.5,
    });
    expect(byLabel['gold loan against jewellery']).toMatchObject({
      coverage: 'none',
      covered_by_entry_id: null,
      coverage_p: 0.15,
    });
    // entry ids never reach TypeSafe
    for (const c of sim.calls) expect(c.raw).not.toContain(E1);
  });

  it('stores coverage unknown and no intent when Jev is unavailable', async () => {
    const rpc = fakeDb();
    const r = await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    expect(r).toMatchObject({ ok: true, judged: 0 });
    for (const t of replaceArgs(rpc).p_topics)
      expect(t).toMatchObject({
        coverage: 'unknown',
        intent: null,
        coverage_p: null,
        covered_by_entry_id: null,
      });
    expect(rpc.mock.calls.some((c) => c[0] === 'kb_shortlist')).toBe(false);
  });

  it('stores coverage unknown when a Jev request fails', async () => {
    const rpc = fakeDb();
    h.layer = makeLayer({ sim: makeSim(() => ({ model: 'jev-9.9.9' })) }).layer;
    const r = await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    expect(r).toMatchObject({ ok: true, judged: 0 });
    expect(
      replaceArgs(rpc).p_topics.every((t) => t.coverage === 'unknown')
    ).toBe(true);
  });

  it('carries a dismissal over to the re-formed topic', async () => {
    const rpc = fakeDb({
      topics: [
        {
          id: 'old',
          status: 'dismissed',
          dismissed_at: '2026-10-23T00:00:00Z',
        },
      ],
      members: GAPS.slice(0, 3).map((g) => ({ topic_id: 'old', gap_id: g.id })),
    });
    await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    const topics = replaceArgs(rpc).p_topics;
    expect(topics.find((t) => t.question_count === 3)).toMatchObject({
      status: 'dismissed',
      dismissed_at: '2026-10-23T00:00:00Z',
    });
    expect(topics.filter((t) => t.status === 'open')).toHaveLength(2);
  });

  it('groups by embedding with an embeddings key, lexically when embedding fails', async () => {
    fakeDb();
    h.loadAiConfig.mockResolvedValue({ embeddingsApiKey: 'sk-e' });
    h.embedTexts.mockResolvedValue(
      GAPS.map((_, i) => (i < 3 ? [1, 0] : [0, 1]))
    );
    expect(
      await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW })
    ).toMatchObject({
      ok: true,
      mode: 'embedding',
      topics: 2,
    });
    expect(h.embedTexts).toHaveBeenCalledWith(
      'sk-e',
      GAPS.map((g) => g.question).reverse()
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.embedTexts.mockRejectedValue(new Error('quota'));
    expect(
      await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW })
    ).toMatchObject({
      ok: true,
      mode: 'lexical',
      topics: 3,
    });
    warn.mockRestore();
  });

  it('clips a label over 500 characters at a word boundary', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    expect(long.length).toBeGreaterThan(TOPIC_LABEL_MAX);
    const rpc = fakeDb({
      gaps: [gap('1', long, 20), gap('2', long, 21), gap('3', long, 22)],
    });
    expect(
      await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW })
    ).toMatchObject({ ok: true, topics: 1 });
    const label = replaceArgs(rpc).p_topics[0]!.label as string;
    expect(label.length).toBeLessThanOrEqual(TOPIC_LABEL_MAX);
    expect(label.endsWith('…')).toBe(true);
    const kept = label.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' '); // cut between words
  });

  it('starts no judgment and skips embedding when the budget is nearly spent', async () => {
    const rpc = fakeDb();
    const sim = jev();
    h.loadAiConfig.mockResolvedValue({ embeddingsApiKey: 'sk-e' });
    const r = await recomputeKbGapTopics(TEST_ACCOUNT, {
      now: NOW,
      deadlineAt: Date.now() + 50, // under one Jev request's timeout (80 ms here)
    });
    expect(r).toEqual({ ok: true, topics: 3, mode: 'lexical', judged: 0 });
    expect(sim.calls).toHaveLength(0);
    expect(h.embedTexts).not.toHaveBeenCalled();
    for (const t of replaceArgs(rpc).p_topics)
      expect(t).toMatchObject({ coverage: 'unknown', intent: null });
  });

  it('sends the statuses it read as p_expected', async () => {
    const rpc = fakeDb({
      topics: [{ id: 'old', status: 'open', dismissed_at: null }],
    });
    await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    expect(replaceArgs(rpc).p_expected).toEqual({ old: 'open' });
  });

  it('on STALE carries the new dismissal over without asking Jev again', async () => {
    const rpc = fakeDb({
      topics: [{ id: 'old', status: 'open', dismissed_at: null }],
      replaceResults: [STALE],
      // A person dismissed the topic while the run was working.
      onReplace: (tables, call) => {
        if (call !== 0) return;
        tables.kb_gap_topics = [
          {
            id: 'old',
            status: 'dismissed',
            dismissed_at: '2026-10-23T00:00:00Z',
          },
        ];
        tables.kb_gap_topic_members = GAPS.slice(0, 3).map((g) => ({
          topic_id: 'old',
          gap_id: g.id,
        }));
      },
    });
    const sim = jev();
    const r = await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW });
    expect(r).toMatchObject({ ok: true, topics: 3, judged: 3 });
    expect(sim.calls).toHaveLength(3); // one judgment per topic, not two
    const [first, second] = allReplaceArgs(rpc);
    expect(first!.p_expected).toEqual({ old: 'open' });
    expect(second!.p_expected).toEqual({ old: 'dismissed' });
    expect(second!.p_topics.find((t) => t.question_count === 3)).toMatchObject({
      status: 'dismissed',
      dismissed_at: '2026-10-23T00:00:00Z',
      coverage: 'full',
    });
  });

  it('gives up after two STALE retries', async () => {
    const rpc = fakeDb({ replaceError: STALE });
    expect(await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW })).toEqual({
      ok: false,
      reason: 'replace: changed',
    });
    expect(allReplaceArgs(rpc)).toHaveLength(3);
  });

  it('reports a failed replace as ok false', async () => {
    fakeDb({ replaceError: { message: 'foreign gap id' } });
    expect(await recomputeKbGapTopics(TEST_ACCOUNT, { now: NOW })).toEqual({
      ok: false,
      reason: 'replace: foreign gap id',
    });
  });
});

describe('accountsDueForGapRecompute', () => {
  it('keeps accounts with at least three gaps, most first', async () => {
    const rows = [
      ...Array(3).fill({ account_id: 'a' }),
      ...Array(2).fill({ account_id: 'b' }),
      ...Array(5).fill({ account_id: 'c' }),
    ];
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'gte', 'order', 'range']) b[m] = () => b;
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(ok);
    const db = { from: () => b } as never;
    expect(await accountsDueForGapRecompute(db, NOW)).toEqual(['c', 'a']);
  });
});

describe('runKbGapRecomputePass', () => {
  it('starts no account after 45 s and gives each min(remaining, 40 s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const rpc = fakeDb({
      scanRows: ['a', 'b', 'c'].flatMap((id) =>
        Array(3).fill({ account_id: id })
      ),
      // Each account's run takes 36 s.
      onReplace: () => vi.setSystemTime(Date.now() + 36_000),
    });
    h.loadAiConfig.mockResolvedValue({ embeddingsApiKey: 'sk-e' });
    h.embedTexts.mockImplementation(async (_k: string, texts: string[]) =>
      texts.map(() => [1, 0])
    );
    const r = await runKbGapRecomputePass();
    // a at 0 s (40 s budget), b at 36 s (9 s left: too little to embed),
    // c not started at 72 s.
    expect(r).toEqual({ accounts: 3, failed: 0, skipped: 1 });
    expect(allReplaceArgs(rpc).map((a) => a.p_account)).toEqual(['a', 'b']);
    expect(h.embedTexts).toHaveBeenCalledTimes(1);
  });
});

describe('clearKbGapTopics', () => {
  it('replaces with no topics against the statuses it read', async () => {
    const rpc = fakeDb({
      topics: [{ id: 't1', status: 'dismissed', dismissed_at: null }],
    });
    expect(await clearKbGapTopics(TEST_ACCOUNT)).toBe(true);
    expect(replaceArgs(rpc)).toEqual({
      p_account: TEST_ACCOUNT,
      p_topics: [],
      p_expected: { t1: 'dismissed' },
    });
  });
});
