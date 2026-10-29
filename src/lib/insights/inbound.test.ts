import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageHash } from '@/lib/typesafe/log';
import { INSIGHT_SETTINGS_OFF, type InsightSettings } from './settings-shape';

// ============================================================
// runInboundInsights: the settings, the decision layer, the conversation
// context and Supabase are stubbed at the module boundary; a recording
// fake stands in for PostgREST.
// ============================================================

interface Call {
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete' | 'rpc';
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
type Result = { data: unknown; error: { message: string } | null };

const MODEL = 'jev-1.13.0';
const HASH_KEY = 'k'.repeat(32);

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  available: true,
  settings: null as unknown,
  insights: vi.fn(),
  layer: true,
  responses: {} as Record<string, Result>,
  context: [] as { role: 'user' | 'assistant'; content: string }[],
  /** When set, `conversations` behaves like one real row: reads return
   *  it, updates apply their filters to it and change it. */
  row: null as Record<string, unknown> | null,
  /** Answers to rpc(fn): a Result, or a function producing one later. */
  rpc: {} as Record<string, Result | (() => Promise<Result>)>,
}));

/** PostgREST filters over one row: eq / is, and an or() of
 *  `col.is.null` / `col.lte.<timestamp>` terms. */
function matches(row: Record<string, unknown>, filters: Call['filters']) {
  for (const [op, col, v] of filters) {
    if ((op === 'eq' || op === 'is') && row[col as string] !== v) return false;
    if (op === 'or') {
      const ok = String(col)
        .split(',')
        .some((term) => {
          const [c, o, ...rest] = term.split('.');
          const cur = row[c!] as string | null;
          if (o === 'is') return cur === null;
          if (o === 'lte')
            return (
              cur !== null && Date.parse(cur) <= Date.parse(rest.join('.'))
            );
          return false;
        });
      if (!ok) return false;
    }
  }
  return true;
}

function respond(call: Call): Result {
  if (h.row && call.table === 'conversations') {
    if (call.op === 'select') return { data: { ...h.row }, error: null };
    if (!matches(h.row, call.filters)) return { data: [], error: null };
    Object.assign(h.row, call.payload);
    return { data: [{ id: h.row.id }], error: null };
  }
  return h.responses[`${call.table}:${call.op}`] ?? { data: null, error: null };
}

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc(fn: string, payload: unknown) {
      h.calls.push({ table: `rpc:${fn}`, op: 'rpc', payload, filters: [] });
      const answer = h.rpc[fn] ?? { data: null, error: null };
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const run = () => {
        h.calls.push(call);
        return Promise.resolve(respond(call));
      };
      const b: Record<string, unknown> = {};
      b.update = (payload: unknown) => {
        call.op = 'update';
        call.payload = payload;
        return b;
      };
      b.insert = (payload: unknown) => {
        call.op = 'insert';
        call.payload = payload;
        return b;
      };
      b.delete = () => {
        call.op = 'delete';
        return b;
      };
      for (const name of [
        'select',
        'eq',
        'or',
        'order',
        'limit',
        'is',
        'neq',
        'not',
        'gte',
        'in',
        'range',
      ]) {
        b[name] = (...args: unknown[]) => {
          call.filters.push([name, ...args]);
          return b;
        };
      }
      b.maybeSingle = () => run();
      b.then = (
        resolve: (r: Result) => unknown,
        reject?: (e: unknown) => unknown
      ) => run().then(resolve, reject);
      return b;
    },
  }),
}));
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: async () => h.context,
}));
vi.mock('./settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: vi.fn(async () => h.settings),
}));
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () =>
    h.layer
      ? {
          config: { model: MODEL, logHashKey: HASH_KEY },
          insights: h.insights,
        }
      : null,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { getInsightSettings } from './settings';
import { runInboundInsights } from './inbound';

const MESSAGE_AT = '2026-10-29T08:00:00.000Z';
/** The server clock when a run reads the chat (Date is faked). */
const READ_AT = '2026-10-29T08:00:03.250Z';
/** Timestamps compared as instants: PostgREST answers `+00:00`. */
const instant = (v: unknown) => Date.parse(v as string);

const run = (text = 'I need a POS terminal today, please call me') =>
  runInboundInsights({
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    messageId: 'wamid.1',
    text,
    messageAt: MESSAGE_AT,
  });

const settings = (s: Partial<InsightSettings>): InsightSettings => ({
  ...INSIGHT_SETTINGS_OFF,
  ...s,
});

const TRIAGE_ANSWERS = {
  intent: {
    choice: 'pos_terminal',
    confidence: 0.6,
    probabilities: { pos_terminal: 0.91, other_banking: 0.09 },
  },
  urgency: { score: 1.7 },
  lead_temperature: { score: 2.4 },
  dissatisfied: { noul: 0.1 },
  wants_human: { noul: 0.2 },
  request_id: 'r-1',
};

const JEV_SIGNALS = {
  intent: { key: 'business_loan', p: 0.7 },
  urgency: 0.2,
  leadTemp: 1.0,
  upset: 0.75,
  wantsHuman: 0.1,
};

const TAG_ROWS = [
  {
    id: 'tag-b',
    name: 'Not interested',
    parent_id: null,
    sub_tag_title: null,
    ai_hint: null,
  },
  {
    id: 'tag-a',
    name: 'Interested',
    parent_id: null,
    sub_tag_title: 'Bank',
    ai_hint: 'wants to apply',
  },
  {
    id: 'sub-a1',
    name: 'ADCB',
    parent_id: 'tag-a',
    sub_tag_title: null,
    ai_hint: 'ADCB',
  },
];

const chatRow = (over: Record<string, unknown> = {}) => ({
  data: {
    chat_tag_id: null,
    chat_sub_tag_id: null,
    tag_suggestion_dismissed_id: null,
    ...over,
  },
  error: null,
});

const tagJudgment = (tag: Record<string, unknown>) => ({
  ok: true,
  signals: null,
  tag: { mainId: null, mainP: 0.5, subId: null, subP: null, ...tag },
  latencyMs: 10,
});

const updates = () => h.calls.filter((c) => c.op === 'update');
const signalUpdate = () =>
  updates().find((c) => 'insight_at' in (c.payload as object));
const suggestionUpdate = () =>
  updates().find((c) => 'suggested_chat_tag_id' in (c.payload as object));

beforeEach(() => {
  __resetRateLimitForTests();
  h.calls = [];
  h.available = true;
  h.layer = true;
  h.settings = settings({});
  h.responses = {
    'chat_tags:select': { data: TAG_ROWS, error: null },
    'conversations:select': chatRow(),
    'ts_decision_log:select': { data: [], error: null },
    'conversations:update': { data: [{ id: 'conv-1' }], error: null },
  };
  h.row = null;
  h.rpc = {};
  h.context = [
    { role: 'assistant', content: 'Hello, how can we help?' },
    { role: 'user', content: 'I need a POS terminal today, please call me' },
  ];
  h.insights.mockReset().mockResolvedValue({
    ok: true,
    signals: JEV_SIGNALS,
    tag: null,
    latencyMs: 5,
  });
  vi.mocked(getInsightSettings).mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(READ_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runInboundInsights — gating', () => {
  it('blank text: no settings, no reads, no request', async () => {
    h.settings = settings({ signalsEnabled: true });
    const out = await run('   \n ');
    expect(out.skipped).toBe('blank');
    expect(getInsightSettings).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.insights).not.toHaveBeenCalled();
  });

  it('Jev unavailable for the account: no settings, no reads, no request', async () => {
    h.available = false;
    h.settings = settings({ signalsEnabled: true, tagSuggestMode: 'auto' });
    const out = await run();
    expect(out.skipped).toBe('unavailable');
    expect(getInsightSettings).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.insights).not.toHaveBeenCalled();
  });

  it('both features off: no reads, no request', async () => {
    const out = await run();
    expect(out.skipped).toBe('off');
    expect(h.calls).toEqual([]);
    expect(h.insights).not.toHaveBeenCalled();
  });

  it('stops at the per-account rate limit', async () => {
    h.settings = settings({ signalsEnabled: true });
    for (let i = 0; i < 120; i++) await run();
    h.insights.mockClear();
    h.calls = [];
    const out = await run();
    expect(out.skipped).toBe('rate_limited');
    expect(h.calls).toEqual([]);
    expect(h.insights).not.toHaveBeenCalled();
  });
});

describe('runInboundInsights — triage reuse', () => {
  it('a triage row for the pinned model supplies the signals; the one request asks only the deep figures', async () => {
    h.settings = settings({ signalsEnabled: true });
    h.responses['ts_decision_log:select'] = {
      data: [{ answers: TRIAGE_ANSWERS, model_id: MODEL }],
      error: null,
    };
    const out = await run();

    const read = h.calls.find((c) => c.table === 'ts_decision_log')!;
    expect(read.filters).toContainEqual([
      'eq',
      'message_id',
      messageHash('wamid.1', HASH_KEY),
    ]);
    expect(read.filters).toContainEqual(['eq', 'check_name', 'triage']);
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(h.insights).toHaveBeenCalledTimes(1);
    expect(h.insights.mock.calls[0][0]).toMatchObject({
      askSignals: false,
      askDeep: true,
      tags: null,
    });
    expect(out.reusedTriage).toBe(true);
    expect(signalUpdate()!.payload).toEqual({
      insight_intent: 'pos_terminal',
      insight_intent_p: 0.91,
      insight_urgency: 1.7,
      insight_lead_temp: 2.4,
      insight_upset: 0.1,
      insight_wants_human: 0.2,
      insight_priority: 2,
      insight_at: MESSAGE_AT,
    });
  });

  it('with tag suggestions on, the one request asks only the tags', async () => {
    h.settings = settings({ signalsEnabled: true, tagSuggestMode: 'suggest' });
    h.responses['ts_decision_log:select'] = {
      data: [{ answers: TRIAGE_ANSWERS, model_id: MODEL }],
      error: null,
    };
    h.insights.mockResolvedValue(tagJudgment({}));
    await run();

    expect(h.insights).toHaveBeenCalledTimes(1);
    const input = h.insights.mock.calls[0][0];
    expect(input.askSignals).toBe(false);
    expect(input.recentTurns).toEqual([
      { from: 'taamul', text: 'Hello, how can we help?' },
    ]);
    expect(signalUpdate()!.payload).toMatchObject({
      insight_intent: 'pos_terminal',
    });
  });

  it('a triage row from another model is not reused', async () => {
    h.settings = settings({ signalsEnabled: true });
    h.responses['ts_decision_log:select'] = {
      data: [{ answers: TRIAGE_ANSWERS, model_id: 'jev-1.12.0' }],
      error: null,
    };
    const out = await run();

    expect(h.insights).toHaveBeenCalledTimes(1);
    expect(h.insights.mock.calls[0][0]).toMatchObject({
      askSignals: true,
      tags: null,
    });
    expect(out.reusedTriage).toBe(false);
    expect(signalUpdate()!.payload).toMatchObject({
      insight_intent: 'business_loan',
      insight_intent_p: 0.7,
      insight_upset: 0.75,
      insight_priority: 1,
    });
  });

  it('a triage row without answers (failed or purged) is not reused', async () => {
    h.settings = settings({ signalsEnabled: true });
    h.responses['ts_decision_log:select'] = {
      data: [{ answers: null, model_id: MODEL }],
      error: null,
    };
    await run();
    expect(h.insights.mock.calls[0][0].askSignals).toBe(true);
  });
});

describe('runInboundInsights — forward-only signals', () => {
  it('updates only this account’s chat, and only if no newer message was judged', async () => {
    h.settings = settings({ signalsEnabled: true });
    await run();
    const u = signalUpdate()!;
    expect(u.table).toBe('conversations');
    expect(u.filters).toContainEqual(['eq', 'id', 'conv-1']);
    expect(u.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(u.filters).toContainEqual([
      'or',
      `insight_at.is.null,insight_at.lte.${MESSAGE_AT}`,
    ]);
  });
});

const DEEP = {
  sentiment: 0.8,
  objections: {
    price: 0.9,
    documents: 0.2,
    eligibility: 0.65,
    trust: 0.1,
    timing: 0.59,
    comparing: 0,
  },
  needsReply: 0.8,
  callback: 0.9,
};

const inserts = (table: string) =>
  h.calls.filter((c) => c.table === table && c.op === 'insert');

describe('runInboundInsights — Customer insights 2.0', () => {
  beforeEach(() => {
    h.settings = settings({ signalsEnabled: true });
    h.insights.mockResolvedValue({
      ok: true,
      signals: JEV_SIGNALS,
      deep: DEEP,
      tag: null,
      latencyMs: 5,
    });
  });

  it('asks the deep figures and writes them in the same forward-only update', async () => {
    const out = await run();
    expect(h.insights.mock.calls[0][0]).toMatchObject({
      askSignals: true,
      askDeep: true,
    });
    expect(out.deep).toEqual(DEEP);
    const u = signalUpdate()!;
    expect(u.payload).toMatchObject({
      insight_intent: 'business_loan',
      insight_sentiment: 0.8,
      insight_objections: ['price', 'eligibility'],
      insight_needs_reply: 0.8,
      insight_callback: 0.9,
      insight_at: MESSAGE_AT,
    });
    expect(u.filters).toContainEqual([
      'or',
      `insight_at.is.null,insight_at.lte.${MESSAGE_AT}`,
    ]);
  });

  it('a newer message already judged keeps its figures, deep ones included', async () => {
    h.row = {
      id: 'conv-1',
      account_id: 'acct-1',
      status: 'open',
      insight_at: '2026-10-29T08:00:05.000Z',
      insight_sentiment: 3,
      insight_attention_at: null,
      insight_attention_reason: null,
    };
    await run();
    expect(h.row).toMatchObject({
      insight_at: '2026-10-29T08:00:05.000Z',
      insight_sentiment: 3,
    });
  });

  it('with Customer insights off, tag suggestions ask no deep figures', async () => {
    h.settings = settings({ tagSuggestMode: 'suggest' });
    h.insights.mockResolvedValue(tagJudgment({}));
    const out = await run();
    expect(h.insights.mock.calls[0][0]).toMatchObject({
      askSignals: false,
      askDeep: false,
    });
    expect(signalUpdate()).toBeUndefined();
    expect(inserts('conversation_insight_events')).toEqual([]);
    expect(out.history).toBeNull();
  });

  it('records one history row per judged message, then trims the chat to its newest 30', async () => {
    h.responses['conversation_insight_events:select'] = {
      data: [{ id: 'old-1' }, { id: 'old-2' }],
      error: null,
    };
    const out = await run();
    expect(out.history).toBe('stored');
    expect(
      inserts('conversation_insight_events').map((c) => c.payload)
    ).toEqual([
      {
        account_id: 'acct-1',
        conversation_id: 'conv-1',
        message_at: MESSAGE_AT,
        figures: {
          intent: 'business_loan',
          urgency: 0.2,
          leadTemp: 1.0,
          upset: 0.75,
          wantsHuman: 0.1,
          sentiment: 0.8,
          objections: ['price', 'eligibility'],
          needsReply: 0.8,
          callback: 0.9,
          priority: 1,
        },
      },
    ]);
    const read = h.calls.find(
      (c) => c.table === 'conversation_insight_events' && c.op === 'select'
    )!;
    expect(read.filters).toContainEqual(['eq', 'conversation_id', 'conv-1']);
    expect(read.filters).toContainEqual([
      'order',
      'message_at',
      { ascending: false },
    ]);
    const [, from, to] = read.filters.find((f) => f[0] === 'range')!;
    expect(from).toBe(30);
    expect(to as number).toBeGreaterThan(30);
    const del = h.calls.find(
      (c) => c.table === 'conversation_insight_events' && c.op === 'delete'
    )!;
    expect(del.filters).toContainEqual(['eq', 'conversation_id', 'conv-1']);
    expect(del.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(del.filters).toContainEqual(['in', 'id', ['old-1', 'old-2']]);
  });

  it('nothing past the newest 30: no delete', async () => {
    h.responses['conversation_insight_events:select'] = {
      data: [],
      error: null,
    };
    await run();
    expect(
      h.calls.some(
        (c) => c.table === 'conversation_insight_events' && c.op === 'delete'
      )
    ).toBe(false);
  });

  it('a failed history insert is logged and changes nothing else', async () => {
    h.responses['conversation_insight_events:insert'] = {
      data: null,
      error: { message: 'down' },
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run();
    expect(out.history).toBe('failed');
    expect(out.skipped).toBeNull();
    expect(out.signalsWritten).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a callback request pins the chat with the workspace’s rules', async () => {
    h.rpc.insight_pin_attention = { data: 'pinned', error: null };
    const out = await run();
    expect(out.attention).toEqual({ result: 'pinned', notified: false });
    expect(
      h.calls.filter((c) => c.op === 'rpc').map((c) => [c.table, c.payload])
    ).toEqual([
      [
        'rpc:insight_pin_attention',
        {
          p_account: 'acct-1',
          p_conv: 'conv-1',
          p_message_at: MESSAGE_AT,
          p_reason: 'callback',
        },
      ],
    ]);
  });

  it('no pin when the matching rule is off', async () => {
    h.settings = settings({
      signalsEnabled: true,
      attentionPinCallback: false,
    });
    const out = await run();
    expect(out.attention).toBeNull();
    expect(h.calls.some((c) => c.op === 'rpc')).toBe(false);
  });
});

describe('runInboundInsights — tag suggestions', () => {
  beforeEach(() => {
    h.settings = settings({ tagSuggestMode: 'suggest' });
  });

  it('asks over the workspace’s tags and stores a confident suggestion', async () => {
    h.insights.mockResolvedValue(
      tagJudgment({ mainId: 'tag-a', mainP: 0.8, subId: 'sub-a1', subP: 0.7 })
    );
    const out = await run();

    const input = h.insights.mock.calls[0][0];
    expect(input.askSignals).toBe(false);
    expect(input.tags).toEqual({
      mains: [
        {
          id: 'tag-b',
          name: 'Not interested',
          hint: null,
          subTitle: null,
          subs: [],
        },
        {
          id: 'tag-a',
          name: 'Interested',
          hint: 'wants to apply',
          subTitle: 'Bank',
          subs: [{ id: 'sub-a1', name: 'ADCB', hint: 'ADCB' }],
        },
      ],
    });
    const tagsRead = h.calls.find((c) => c.table === 'chat_tags')!;
    expect(tagsRead.filters[2]).toEqual([
      'order',
      'position',
      { ascending: true },
    ]);

    const u = suggestionUpdate()!;
    expect(u.payload).toMatchObject({
      suggested_chat_tag_id: 'tag-a',
      suggested_chat_sub_tag_id: 'sub-a1',
      suggested_tag_p: 0.8,
    });
    expect(
      typeof (u.payload as { suggested_tag_at: unknown }).suggested_tag_at
    ).toBe('string');
    expect(u.filters).toContainEqual(['eq', 'id', 'conv-1']);
    expect(u.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(out.suggestion).toBe('stored');
    expect(out.tag).toMatchObject({ mainId: 'tag-a' });
    expect(out.chat).toEqual({
      chatTagId: null,
      chatSubTagId: null,
      dismissedId: null,
    });
    // Signals off: the figures are neither asked nor written.
    expect(signalUpdate()).toBeUndefined();
  });

  it('drops a sub-tag Jev is not sure enough of', async () => {
    h.insights.mockResolvedValue(
      tagJudgment({ mainId: 'tag-a', mainP: 0.8, subId: 'sub-a1', subP: 0.5 })
    );
    await run();
    expect(suggestionUpdate()!.payload).toMatchObject({
      suggested_chat_tag_id: 'tag-a',
      suggested_chat_sub_tag_id: null,
    });
  });

  const cleared = {
    suggested_chat_tag_id: null,
    suggested_chat_sub_tag_id: null,
    suggested_tag_p: null,
    suggested_tag_at: null,
    // A clear is a decision too: it moves the basis to when it read.
    suggestion_basis_at: READ_AT,
  };

  it('clears a stale suggestion when Jev is not sure enough', async () => {
    h.insights.mockResolvedValue(tagJudgment({ mainId: 'tag-a', mainP: 0.4 }));
    const out = await run();
    expect(suggestionUpdate()!.payload).toEqual(cleared);
    expect(out.suggestion).toBe('cleared');
  });

  it('clears when Jev chose none', async () => {
    h.insights.mockResolvedValue(tagJudgment({ mainId: null, mainP: 0.9 }));
    await run();
    expect(suggestionUpdate()!.payload).toEqual(cleared);
  });

  it('does not suggest the tags the chat already has', async () => {
    h.responses['conversations:select'] = chatRow({
      chat_tag_id: 'tag-a',
      chat_sub_tag_id: 'sub-a1',
    });
    h.insights.mockResolvedValue(
      tagJudgment({ mainId: 'tag-a', mainP: 0.9, subId: 'sub-a1', subP: 0.9 })
    );
    await run();
    expect(suggestionUpdate()!.payload).toEqual(cleared);
  });

  it('suggests a sub-tag for a chat that has only the main tag', async () => {
    h.responses['conversations:select'] = chatRow({ chat_tag_id: 'tag-a' });
    h.insights.mockResolvedValue(
      tagJudgment({ mainId: 'tag-a', mainP: 0.9, subId: 'sub-a1', subP: 0.9 })
    );
    await run();
    expect(suggestionUpdate()!.payload).toMatchObject({
      suggested_chat_tag_id: 'tag-a',
      suggested_chat_sub_tag_id: 'sub-a1',
    });
  });

  it('does not suggest a tag a person dismissed', async () => {
    h.responses['conversations:select'] = chatRow({
      tag_suggestion_dismissed_id: 'tag-a',
    });
    h.insights.mockResolvedValue(tagJudgment({ mainId: 'tag-a', mainP: 0.95 }));
    await run();
    expect(suggestionUpdate()!.payload).toEqual(cleared);
  });

  it('a workspace with no main tags asks nothing and writes nothing', async () => {
    h.responses['chat_tags:select'] = { data: [], error: null };
    const out = await run();
    expect(h.insights).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(out.suggestion).toBe('untouched');
  });
});

describe('runInboundInsights — failures', () => {
  it('a failed judgment writes nothing, triage figures included', async () => {
    h.settings = settings({ signalsEnabled: true, tagSuggestMode: 'suggest' });
    h.responses['ts_decision_log:select'] = {
      data: [{ answers: TRIAGE_ANSWERS, model_id: MODEL }],
      error: null,
    };
    h.insights.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 4000,
    });
    const out = await run();
    expect(updates()).toEqual([]);
    expect(out.skipped).toBeNull();
    expect(out.judgment).toMatchObject({ ok: false });
  });

  it('never throws when a read fails', async () => {
    h.settings = settings({ signalsEnabled: true, tagSuggestMode: 'auto' });
    h.responses['chat_tags:select'] = {
      data: null,
      error: { message: 'down' },
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run();
    expect(out.skipped).toBe('error');
    expect(h.insights).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(err).toHaveBeenCalledWith(
      '[insights] inbound judgment failed:',
      'down'
    );
    err.mockRestore();
  });

  it('never throws when a write fails', async () => {
    h.settings = settings({ signalsEnabled: true });
    h.responses['conversations:update'] = {
      data: null,
      error: { message: 'check violated' },
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run();
    expect(out.skipped).toBe('error');
    expect(out.signalsWritten).toBe(false);
    err.mockRestore();
  });

  it('a failed signals write still waits for the pin, and reports both', async () => {
    h.settings = settings({ signalsEnabled: true });
    // DEEP asks for a call back: the workspace's rules pin on it.
    h.insights.mockResolvedValue({
      ok: true,
      signals: JEV_SIGNALS,
      deep: DEEP,
      tag: null,
      latencyMs: 5,
    });
    h.responses['conversations:update'] = {
      data: null,
      error: { message: 'check violated' },
    };
    let pinFinished = false;
    h.rpc.insight_pin_attention = async () => {
      await new Promise((r) => setTimeout(r, 20));
      pinFinished = true;
      return { data: 'pinned', error: null };
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run();
    expect(pinFinished).toBe(true);
    expect(out.skipped).toBe('error');
    expect(out.signalsWritten).toBe(false);
    expect(out.history).toBe('stored');
    expect(out.attention).toEqual({ result: 'pinned', notified: false });
    expect(err).toHaveBeenCalledWith(
      '[insights] inbound write failed:',
      'check violated'
    );
    err.mockRestore();
  });
});

describe('runInboundInsights — the suggestion write is a compare-and-set', () => {
  const T1 = '2026-10-29T08:00:00.000Z';
  const T2 = '2026-10-29T08:00:05.000Z';
  const runAt = (messageAt: string, messageId: string) =>
    runInboundInsights({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      messageId,
      text: 'I want to apply',
      messageAt,
    });

  beforeEach(() => {
    h.settings = settings({ tagSuggestMode: 'suggest' });
    h.row = {
      id: 'conv-1',
      account_id: 'acct-1',
      chat_tag_id: null,
      chat_sub_tag_id: null,
      tag_suggestion_dismissed_id: null,
      suggested_chat_tag_id: null,
      suggested_chat_sub_tag_id: null,
      suggested_tag_p: null,
      suggested_tag_at: null,
      suggestion_basis_at: null,
    };
  });

  it('stores, and moves the basis to when it read the chat, when nothing changed', async () => {
    h.insights.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 4000)); // Jev takes seconds
      return tagJudgment({ mainId: 'tag-a', mainP: 0.8 });
    });
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('stored');
    expect(out.basisAt).toBe(READ_AT);
    expect(h.row!.suggested_chat_tag_id).toBe('tag-a');
    expect(instant(h.row!.suggestion_basis_at)).toBe(instant(READ_AT));
  });

  it('a delayed message judged after a person changed the tags still gets a suggestion', async () => {
    // The person's save (stamped then, in PostgREST's offset form) came
    // before this run read the chat, though after the message was sent.
    h.row!.chat_tag_id = 'tag-b';
    h.row!.suggestion_basis_at = '2026-10-29T08:00:02.000+00:00';
    h.insights.mockResolvedValue(tagJudgment({ mainId: 'tag-a', mainP: 0.8 }));
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('stored');
    expect(instant(h.row!.suggestion_basis_at)).toBe(instant(READ_AT));
  });

  it('a basis later by the instant, not by the string, refuses the write', async () => {
    // 04:00:03.251-04:00 is 08:00:03.251Z: 1 ms after this run read the
    // chat, though it sorts before READ_AT as text.
    h.row!.suggestion_basis_at = '2026-10-29T04:00:03.251-04:00';
    h.insights.mockResolvedValue(tagJudgment({ mainId: 'tag-a', mainP: 0.8 }));
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBeNull();
  });

  it('a dismissal during the Jev call is not undone', async () => {
    h.insights.mockImplementation(async () => {
      h.row!.tag_suggestion_dismissed_id = 'tag-b';
      return tagJudgment({ mainId: 'tag-a', mainP: 0.8 });
    });
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBeNull();
    expect(h.row!.suggestion_basis_at).toBeNull();
  });

  it('a chat a person tagged during the Jev call gets no stale suggestion', async () => {
    h.insights.mockImplementation(async () => {
      // What the PUT route does: the tag, then the clear stamping now.
      vi.setSystemTime(new Date(Date.now() + 1000));
      h.row!.chat_tag_id = 'tag-b';
      h.row!.suggestion_basis_at = new Date().toISOString();
      return tagJudgment({ mainId: 'tag-a', mainP: 0.8 });
    });
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBeNull();
  });

  it('a chat a person tagged and untagged during the Jev call is not overruled', async () => {
    h.insights.mockImplementation(async () => {
      // Two saves through the PUT route: the tags read the same again,
      // the basis does not.
      vi.setSystemTime(new Date(Date.now() + 1000));
      h.row!.chat_tag_id = 'tag-b';
      h.row!.suggestion_basis_at = new Date().toISOString();
      vi.setSystemTime(new Date(Date.now() + 1000));
      h.row!.chat_tag_id = null;
      h.row!.suggestion_basis_at = new Date().toISOString();
      return tagJudgment({ mainId: 'tag-a', mainP: 0.9 });
    });
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBeNull();
  });

  it('of two messages sent in the same second, the one judged from an older read does not overwrite the other', async () => {
    let releaseOlder!: () => void;
    const olderHeld = new Promise<void>((r) => (releaseOlder = r));
    h.insights.mockImplementation(async (input: { message: string }) => {
      if (input.message === 'older') {
        await olderHeld;
        return tagJudgment({ mainId: 'tag-a', mainP: 0.8 });
      }
      return tagJudgment({ mainId: 'tag-b', mainP: 0.9 });
    });
    const older = runInboundInsights({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      messageId: 'wamid.1',
      text: 'older',
      messageAt: T1,
    });
    // Let the older run read the chat and reach Jev first.
    await vi.waitFor(() => expect(h.insights).toHaveBeenCalledTimes(1));
    const newerRead = Date.now() + 1; // read 1 ms after the older run's
    vi.setSystemTime(new Date(newerRead));
    const newer = await runInboundInsights({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      messageId: 'wamid.2',
      text: 'newer',
      messageAt: T1, // the same whole second as the older one
    });
    expect(newer.suggestion).toBe('stored');
    releaseOlder();
    expect((await older).suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBe('tag-b');
    expect(instant(h.row!.suggestion_basis_at)).toBe(newerRead);
  });

  it("an older read cannot clear a later decision's suggestion either", async () => {
    h.row!.suggested_chat_tag_id = 'tag-b';
    h.row!.suggestion_basis_at = T2;
    h.insights.mockResolvedValue(tagJudgment({ mainId: 'tag-a', mainP: 0.3 }));
    const out = await runAt(T1, 'wamid.1');
    expect(out.suggestion).toBe('superseded');
    expect(h.row!.suggested_chat_tag_id).toBe('tag-b');
  });
});
