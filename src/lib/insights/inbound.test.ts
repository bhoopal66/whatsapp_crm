import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messageHash } from '@/lib/typesafe/log';
import { INSIGHT_SETTINGS_OFF, type InsightSettings } from './settings-shape';

// ============================================================
// runInboundInsights: the settings, the decision layer, the conversation
// context and Supabase are stubbed at the module boundary; a recording
// fake stands in for PostgREST.
// ============================================================

interface Call {
  table: string;
  op: 'select' | 'update';
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
}));

function respond(call: Call): Result {
  return h.responses[`${call.table}:${call.op}`] ?? { data: null, error: null };
}

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
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
      for (const name of ['select', 'eq', 'or', 'order', 'limit', 'is']) {
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
  };
  h.context = [
    { role: 'assistant', content: 'Hello, how can we help?' },
    { role: 'user', content: 'I need a POS terminal today, please call me' },
  ];
  h.insights
    .mockReset()
    .mockResolvedValue({
      ok: true,
      signals: JEV_SIGNALS,
      tag: null,
      latencyMs: 5,
    });
  vi.mocked(getInsightSettings).mockClear();
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
  it('a triage row for the pinned model supplies the signals; nothing else to ask means no request', async () => {
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
    expect(h.insights).not.toHaveBeenCalled();
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
});
