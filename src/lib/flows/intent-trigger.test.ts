import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Flow `intent` entry triggers (meaning triggers): the real
// `dispatchInboundToFlows` against a fake Supabase, with judgeMeanings
// stubbed at the module boundary.
// ============================================================

const h = vi.hoisted(() => ({
  flows: [] as Record<string, unknown>[],
  inserted: [] as { table: string; row: Record<string, unknown> }[],
  insertedRun: null as Record<string, unknown> | null,
  judge: vi.fn(),
}));

vi.mock('./admin-client', () => {
  const rows = (t: string): unknown[] =>
    t === 'flows' ? h.flows : t === 'flow_nodes' ? NODES : [];
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      is: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        h.inserted.push({ table, row });
        if (table === 'flow_runs')
          h.insertedRun = { id: 'run-1', vars: {}, reprompt_count: 0, ...row };
        return b;
      },
      maybeSingle: async () => ({
        data: table === 'flow_runs' ? h.insertedRun : (rows(table)[0] ?? null),
        error: null,
      }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) =>
        resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});
vi.mock('./channel-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'w1' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'w2' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'w3',
  })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: 'w4' })),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => 'skipped'),
}));
vi.mock('@/lib/insights/meaning', async (importOriginal) => ({
  meaningCandidate: (
    await importOriginal<typeof import('@/lib/insights/meaning')>()
  ).meaningCandidate,
  judgeMeanings: (...a: unknown[]) =>
    (h.judge as unknown as (...x: unknown[]) => unknown)(...a),
  loadMeaningTurns: async () => [],
}));

import { dispatchInboundToFlows, pickIntentFlow } from './engine';
import type { FlowRow, ParsedInbound } from './types';

const NODES = [
  {
    id: 'n1',
    flow_id: 'f',
    node_key: 'start',
    node_type: 'start',
    config: { next_node_key: 'done' },
  },
  { id: 'n2', flow_id: 'f', node_key: 'done', node_type: 'end', config: {} },
];

const flow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  account_id: 'acct-1',
  user_id: 'u-1',
  status: 'active',
  entry_node_id: 'start',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  trigger_type: 'intent',
  trigger_config: { description: `Customer means ${id}` },
  ...extra,
});

const text = (t: string): ParsedInbound => ({
  kind: 'text',
  text: t,
  meta_message_id: 'wamid.in',
});

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message,
    isFirstInboundMessage: false,
  });
}

const startedFlow = () =>
  h.inserted.find((i) => i.table === 'flow_runs')?.row.flow_id ?? null;

/** The real threshold rule over a p per flow id. */
function judgeWith(P: Record<string, number>) {
  h.judge.mockImplementation(
    async (input: { candidates: { key: string; threshold: number }[] }) =>
      new Map(
        input.candidates
          .map((c) => [c.key, P[c.key.slice(5)]] as const)
          .filter(
            (e): e is readonly [string, number] =>
              e[1] !== undefined &&
              e[1] >= input.candidates.find((c) => c.key === e[0])!.threshold
          )
      )
  );
}

beforeEach(() => {
  h.flows = [];
  h.inserted = [];
  h.insertedRun = null;
  h.judge.mockReset();
  h.judge.mockResolvedValue(new Map());
});

describe('flow intent triggers', () => {
  it('a keyword flow wins, and Jev is never asked', async () => {
    h.flows = [
      flow('intent-1'),
      flow('kw-1', {
        trigger_type: 'keyword',
        trigger_config: { keywords: ['loan'] },
      }),
    ];
    judgeWith({ 'intent-1': 0.99 });
    await dispatch(text('I want a loan'));
    expect(startedFlow()).toBe('kw-1');
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('starts an intent flow at its threshold, with the inbound as the memo key', async () => {
    h.flows = [flow('intent-1')];
    judgeWith({ 'intent-1': 0.75 });
    const r = await dispatch(text('can I borrow money'));
    expect(r.consumed).toBe(true);
    expect(startedFlow()).toBe('intent-1');
    expect(h.judge.mock.calls[0]![0]).toMatchObject({
      accountId: 'acct-1',
      messageKey: 'wamid.in',
      text: 'can I borrow money',
      candidates: [
        {
          key: 'flow:intent-1',
          description: 'Customer means intent-1',
          threshold: 0.75,
        },
      ],
    });
  });

  it('does not start below the threshold; sensitivity sets it', async () => {
    h.flows = [
      flow('intent-1', {
        trigger_config: {
          description: 'Customer means x',
          sensitivity: 'strict',
        },
      }),
    ];
    judgeWith({ 'intent-1': 0.84 });
    const r = await dispatch(text('maybe a loan'));
    expect(r).toMatchObject({ consumed: false, outcome: 'no_match' });
    expect(startedFlow()).toBeNull();
    expect(
      (h.judge.mock.calls[0]![0] as { candidates: { threshold: number }[] })
        .candidates[0]!.threshold
    ).toBe(0.85);
  });

  it('the highest p wins', async () => {
    h.flows = [flow('a'), flow('b')];
    judgeWith({ a: 0.8, b: 0.9 });
    await dispatch(text('hello'));
    expect(startedFlow()).toBe('b');
  });

  it('asks nothing for a button tap or when no intent flow is active', async () => {
    h.flows = [flow('a')];
    await dispatch({
      kind: 'interactive_reply',
      reply_id: 'btn_1',
      reply_title: 'Loans',
      meta_message_id: 'wamid.in',
    });
    h.flows = [
      flow('kw', {
        trigger_type: 'keyword',
        trigger_config: { keywords: ['zzz'] },
      }),
    ];
    await dispatch(text('hello'));
    expect(h.judge).not.toHaveBeenCalled();
  });

  it('starts nothing when meaning triggers are off (no match from the judge)', async () => {
    h.flows = [flow('a')];
    h.judge.mockResolvedValue(new Map());
    const r = await dispatch(text('I want a loan'));
    expect(r.consumed).toBe(false);
    expect(startedFlow()).toBeNull();
  });
});

describe('pickIntentFlow', () => {
  const f = (id: string, updated_at: string) =>
    flow(id, { updated_at }) as unknown as FlowRow;

  it('breaks a tie by the most recently updated flow, whatever the order', () => {
    const old = f('a', '2026-01-01T00:00:00Z');
    const recent = f('b', '2026-03-01T00:00:00Z');
    const m = new Map([
      ['flow:a', 0.8],
      ['flow:b', 0.8],
    ]);
    expect(pickIntentFlow([old, recent], m)?.id).toBe('b');
    expect(pickIntentFlow([recent, old], m)?.id).toBe('b');
  });

  it('then by id, and ignores flows not matched', () => {
    const x = f('x', '2026-01-01T00:00:00Z');
    const y = f('y', '2026-01-01T00:00:00Z');
    const m = new Map([
      ['flow:x', 0.8],
      ['flow:y', 0.8],
    ]);
    expect(pickIntentFlow([y, x], m)?.id).toBe('y');
    expect(pickIntentFlow([x, y], new Map())).toBeNull();
  });
});
