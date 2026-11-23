import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ============================================================
// Typed answers to buttons and lists, through the real
// `dispatchInboundToFlows` against a fake Supabase: a typed label,
// number or meaning advances the waiting run exactly as a tap would;
// anything else (or the switch off) leaves today's fallback untouched.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    activeRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; row: Record<string, unknown> }[],
    /** The optimistic node update matches no row (a concurrent tap won). */
    zeroAdvance: false,
  },
  available: true,
  meaningOn: true,
  replyOption: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
}));

vi.mock('./admin-client', () => {
  function rows(table: string): unknown[] {
    if (table === 'flow_runs') return h.state.activeRuns;
    if (table === 'flows') return h.state.flows;
    if (table === 'flow_nodes') return h.state.nodes;
    return [];
  }
  function builder(table: string) {
    let written: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        h.state.updates.push({ table, row });
        written = row;
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        return b;
      },
      maybeSingle: async () => ({ data: rows(table)[0] ?? null, error: null }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) =>
        resolve({
          data:
            h.state.zeroAdvance &&
            table === 'flow_runs' &&
            written &&
            'current_node_key' in written
              ? []
              : rows(table),
          error: null,
          count: 0,
        }),
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

const engineSendInteractiveButtons = vi.fn(async () => ({
  whatsapp_message_id: 'wamid.3',
}));
vi.mock('./channel-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid.1' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.2' })),
  engineSendInteractiveButtons: (...a: unknown[]) =>
    (engineSendInteractiveButtons as unknown as (...x: unknown[]) => unknown)(
      ...a
    ),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.4',
  })),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => 'skipped'),
}));
vi.mock('@/lib/insights/meaning', () => ({
  judgeMeanings: vi.fn(async () => new Map()),
  loadMeaningTurns: vi.fn(async () => []),
}));
vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => ({ meaningTriggersEnabled: h.meaningOn }),
}));
vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => ({
    replyOption: (...a: unknown[]) => h.replyOption(...a),
  }),
}));

import { dispatchInboundToFlows } from './engine';

const FLOW = {
  id: 'flow-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  name: 'Menu',
  status: 'active',
  trigger_type: 'keyword',
  trigger_config: { keywords: ['menu'] },
  entry_node_id: 'start',
  created_at: '2026-01-01T00:00:00Z',
};

const NODES = [
  {
    id: 'n2',
    flow_id: 'flow-1',
    node_key: 'menu',
    node_type: 'send_buttons',
    config: {
      text: 'Quote or comparison?',
      buttons: [
        { reply_id: 'quote', title: 'Get a quote', next_node_key: 'q_end' },
        { reply_id: 'compare', title: 'Compare', next_node_key: 'c_end' },
      ],
    },
  },
  {
    id: 'n3',
    flow_id: 'flow-1',
    node_key: 'q_end',
    node_type: 'end',
    config: {},
  },
  {
    id: 'n4',
    flow_id: 'flow-1',
    node_key: 'c_end',
    node_type: 'end',
    config: {},
  },
];

const ACTIVE_RUN = {
  id: 'run-1',
  flow_id: 'flow-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  contact_id: 'ct-1',
  conversation_id: 'cv-1',
  status: 'active',
  current_node_key: 'menu',
  vars: {},
  reprompt_count: 2,
};

function sendText(text: string, inboundProvider?: 'whapi' | 'meta' | 'openwa') {
  return dispatchInboundToFlows({
    inboundProvider,
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message: { kind: 'text', text, meta_message_id: 'm2' },
    isFirstInboundMessage: false,
  });
}

const runUpdates = () =>
  h.state.updates.filter((u) => u.table === 'flow_runs').map((u) => u.row);
const events = () =>
  h.state.inserted
    .filter((i) => i.table === 'flow_run_events')
    .map((i) => i.row);
const matchEvent = () =>
  events().find(
    (e) =>
      e.event_type === 'node_entered' &&
      (e.payload as Record<string, unknown>).matched_by !== undefined
  );

function expectAdvancedTo(nodeKey: string) {
  // The targets are end nodes: the run completes there.
  expect(events()).toContainEqual(
    expect.objectContaining({ event_type: 'completed', node_key: nodeKey })
  );
  expect(runUpdates()).toContainEqual(
    expect.objectContaining({ status: 'completed' })
  );
  // Reprompt counter reset, as on a tap.
  expect(runUpdates()).toContainEqual(
    expect.objectContaining({ reprompt_count: 0 })
  );
  expect(engineSendInteractiveButtons).not.toHaveBeenCalled();
}

function expectFallback() {
  expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
  expect(runUpdates()).toContainEqual({ reprompt_count: 3 });
  expect(events().some((e) => e.event_type === 'completed')).toBe(false);
  expect(matchEvent()).toBeUndefined();
}

beforeEach(() => {
  h.state.activeRuns = [{ ...ACTIVE_RUN }];
  h.state.flows = [{ ...FLOW, fallback_policy: { max_reprompts: 5 } }];
  h.state.nodes = NODES;
  h.state.inserted = [];
  h.state.updates = [];
  h.state.zeroAdvance = false;
  h.available = true;
  h.meaningOn = true;
  h.replyOption = vi.fn(async () => ({
    ok: true,
    index: null,
    p: 0.9,
    latencyMs: 5,
  }));
  engineSendInteractiveButtons.mockClear();
});

describe('typed answers to a waiting send_buttons node', () => {
  it('advances on a typed label, without asking Jev', async () => {
    await sendText('compare!');
    expectAdvancedTo('c_end');
    expect(matchEvent()).toMatchObject({
      node_key: 'menu',
      payload: { reply_id: 'compare', matched_by: 'label' },
    });
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it('advances on a typed number, without asking Jev', async () => {
    await sendText('#1');
    expectAdvancedTo('q_end');
    expect(matchEvent()).toMatchObject({
      payload: { reply_id: 'quote', matched_by: 'number' },
    });
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it("advances on Jev's meaning at or above the threshold, logging p", async () => {
    h.replyOption.mockResolvedValue({
      ok: true,
      index: 1,
      p: 0.82,
      latencyMs: 5,
    });
    await sendText('yes the second one');
    expectAdvancedTo('c_end');
    expect(matchEvent()).toMatchObject({
      payload: { reply_id: 'compare', matched_by: 'meaning', p: 0.82 },
    });
    expect(h.replyOption).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        prompt: 'Quote or comparison?',
        message: 'yes the second one',
        deadlineMs: 1200,
        options: [
          { title: 'Get a quote', description: undefined },
          { title: 'Compare', description: undefined },
        ],
      })
    );
  });

  it('falls back below the threshold', async () => {
    h.replyOption.mockResolvedValue({
      ok: true,
      index: 1,
      p: 0.6,
      latencyMs: 5,
    });
    await sendText('maybe the other');
    expectFallback();
  });

  it('falls back when Jev says none, or fails', async () => {
    await sendText('how much is it?');
    expectFallback();

    h.state.updates = [];
    h.state.inserted = [];
    engineSendInteractiveButtons.mockClear();
    h.replyOption.mockResolvedValue({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
      latencyMs: 5,
    });
    await sendText('how much is it?');
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(matchEvent()).toBeUndefined();
  });

  it('does not ask Jev about a long free-form text', async () => {
    await sendText(`${'how does the comparison work exactly '.repeat(5)}?`);
    expectFallback();
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it('writes no match event when the advance fails', async () => {
    h.state.nodes = NODES.filter(
      (n) => (n as { node_key: string }).node_key !== 'c_end'
    );
    await sendText('compare!');
    expect(events()).toContainEqual(
      expect.objectContaining({ event_type: 'error', node_key: 'c_end' })
    );
    expect(matchEvent()).toBeUndefined();
  });

  it('writes no match event when the advance lost the race to a concurrent tap', async () => {
    h.state.nodes = [
      ...NODES.filter((n) => (n as { node_key: string }).node_key !== 'c_end'),
      {
        id: 'n5',
        flow_id: 'flow-1',
        node_key: 'c_end',
        node_type: 'send_buttons',
        config: {
          text: 'Which bank?',
          buttons: [{ reply_id: 'b1', title: 'Bank', next_node_key: 'q_end' }],
        },
      },
    ];
    h.state.zeroAdvance = true;
    await sendText('compare!');
    // The claim comes before the send: the loser sends nothing.
    expect(engineSendInteractiveButtons).not.toHaveBeenCalled();
    expect(matchEvent()).toBeUndefined();
  });

  it('changes nothing with the setting off: even a label falls back', async () => {
    h.meaningOn = false;
    await sendText('Compare');
    expectFallback();
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it('changes nothing when Jev is unavailable', async () => {
    h.available = false;
    await sendText('2');
    expectFallback();
    expect(h.replyOption).not.toHaveBeenCalled();
  });
});

describe('a menu sent as numbered text (OpenWA) with the switch off', () => {
  beforeEach(() => {
    h.meaningOn = false;
  });

  it('advances on a typed number', async () => {
    await sendText('2', 'openwa');
    expectAdvancedTo('c_end');
    expect(matchEvent()).toMatchObject({
      payload: { reply_id: 'compare', matched_by: 'number' },
    });
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it('advances on an Arabic-Indic digit', async () => {
    await sendText('\u0662', 'openwa');
    expectAdvancedTo('c_end');
  });

  it('advances on the exact title', async () => {
    await sendText('Get a quote', 'openwa');
    expectAdvancedTo('q_end');
    expect(matchEvent()).toMatchObject({
      payload: { reply_id: 'quote', matched_by: 'label' },
    });
  });

  it('still never asks Jev for a meaning', async () => {
    await sendText('the second one please', 'openwa');
    expectFallback();
    expect(h.replyOption).not.toHaveBeenCalled();
  });

  it('is unchanged on Whapi and Meta, which send real buttons', async () => {
    await sendText('2', 'whapi');
    expectFallback();
    engineSendInteractiveButtons.mockClear();
    h.state.updates.length = 0;
    h.state.inserted.length = 0;
    await sendText('2', 'meta');
    expectFallback();
  });
});

describe('a menu sent as numbered text with the switch on', () => {
  it('behaves as before on OpenWA: number, then meaning', async () => {
    await sendText('2', 'openwa');
    expectAdvancedTo('c_end');
    expect(h.replyOption).not.toHaveBeenCalled();
  });
});
