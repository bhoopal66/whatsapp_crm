import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSIGHT_SETTINGS_OFF, type InsightSettings } from './settings-shape';

// ============================================================
// suggestTagForConversation: settings, the decision layer, the
// conversation context and Supabase are stubbed at the module boundary.
// ============================================================

interface Call {
  table: string;
  op: 'select' | 'update';
  payload?: unknown;
  filters: unknown[][];
}
type Result = { data: unknown; error: { message: string } | null };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  available: true,
  layer: true,
  settings: null as unknown,
  insights: vi.fn(),
  responses: {} as Record<string, Result>,
  context: [] as { role: 'user' | 'assistant'; content: string; at?: string }[],
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const run = () => {
        h.calls.push(call);
        return Promise.resolve(
          h.responses[`${table}:${call.op}`] ?? { data: null, error: null }
        );
      };
      const b: Record<string, unknown> = {};
      b.update = (payload: unknown) => {
        call.op = 'update';
        call.payload = payload;
        return b;
      };
      for (const name of ['select', 'eq', 'order', 'limit', 'is', 'or']) {
        b[name] = (...args: unknown[]) => {
          call.filters.push([name, ...args]);
          return b;
        };
      }
      b.maybeSingle = () => run();
      b.then = (resolve: (r: Result) => unknown) => run().then(resolve);
      return b;
    },
  }),
}));
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: async () => h.context,
}));
vi.mock('./settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => h.settings,
}));
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () => (h.layer ? { insights: h.insights } : null),
}));

import { suggestTagForConversation } from './suggest-now';

const settings = (s: Partial<InsightSettings>): InsightSettings => ({
  ...INSIGHT_SETTINGS_OFF,
  ...s,
});

const TAG_ROWS = [
  {
    id: 'tag-a',
    name: 'Interested',
    parent_id: null,
    sub_tag_title: 'Bank',
    ai_hint: null,
  },
  {
    id: 'sub-a1',
    name: 'ADCB',
    parent_id: 'tag-a',
    sub_tag_title: null,
    ai_hint: null,
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

const judged = (tag: Record<string, unknown>) => ({
  ok: true,
  signals: null,
  tag: { mainId: 'tag-a', mainP: 0.9, subId: null, subP: null, ...tag },
  latencyMs: 5,
});

/** Created_at of the latest customer message: not the basis. */
const MESSAGE_AT = '2026-10-29T08:00:00.000Z';
/** The server clock when the chat is read (Date is faked): the basis. */
const BASIS = '2026-10-29T08:00:07.125Z';
const suggest = () => suggestTagForConversation('acct-1', 'conv-1');
const update = () => h.calls.find((c) => c.op === 'update');

beforeEach(() => {
  h.calls = [];
  h.available = true;
  h.layer = true;
  h.settings = settings({ tagSuggestMode: 'suggest' });
  h.responses = {
    'chat_tags:select': { data: TAG_ROWS, error: null },
    'conversations:select': chatRow(),
    'conversations:update': { data: [{ id: 'conv-1' }], error: null },
  };
  h.context = [
    { role: 'user', content: 'hi', at: '2026-10-29T07:00:00.000Z' },
    { role: 'assistant', content: 'Hello, how can we help?' },
    { role: 'user', content: 'I want a loan from ADCB', at: MESSAGE_AT },
    { role: 'assistant', content: 'Sure, one moment' },
  ];
  h.insights.mockReset().mockResolvedValue(judged({}));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(BASIS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('suggestTagForConversation', () => {
  it('asks the tag question on the latest customer message and stores the suggestion', async () => {
    h.insights.mockResolvedValue(judged({ subId: 'sub-a1', subP: 0.8 }));
    const r = await suggest();
    expect(r).toEqual({
      ok: true,
      suggestion: { mainId: 'tag-a', subId: 'sub-a1', p: 0.9 },
    });
    const req = h.insights.mock.calls[0][0];
    expect(req).toMatchObject({
      accountId: 'acct-1',
      message: 'I want a loan from ADCB',
      askSignals: false,
      recentTurns: [
        { from: 'customer', text: 'hi' },
        { from: 'taamul', text: 'Hello, how can we help?' },
      ],
    });
    expect(req.tags.mains.map((m: { id: string }) => m.id)).toEqual(['tag-a']);
    expect(update()!.payload).toMatchObject({
      suggested_chat_tag_id: 'tag-a',
      suggested_chat_sub_tag_id: 'sub-a1',
      suggested_tag_p: 0.9,
      suggestion_basis_at: BASIS,
    });
    // A compare-and-set on what the decision read, based on when it read
    // the chat (not on the message's own timestamp).
    expect(update()!.filters).toEqual([
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acct-1'],
      ['is', 'chat_tag_id', null],
      ['is', 'chat_sub_tag_id', null],
      ['is', 'tag_suggestion_dismissed_id', null],
      ['or', `suggestion_basis_at.is.null,suggestion_basis_at.lte.${BASIS}`],
      ['select', 'id'],
    ]);
  });

  it('superseded: the chat moved on while Jev was asked, nothing reported', async () => {
    h.responses['conversations:select'] = chatRow({
      chat_tag_id: 'tag-b',
      tag_suggestion_dismissed_id: 'tag-c',
    });
    h.responses['conversations:update'] = { data: [], error: null };
    const r = await suggest();
    expect(r).toEqual({ ok: true, suggestion: null, reason: 'superseded' });
    expect(update()!.filters).toContainEqual(['eq', 'chat_tag_id', 'tag-b']);
    expect(update()!.filters).toContainEqual([
      'eq',
      'tag_suggestion_dismissed_id',
      'tag-c',
    ]);
  });

  it('works in Auto mode too, and never tags the chat', async () => {
    h.settings = settings({ tagSuggestMode: 'auto' });
    const r = await suggest();
    expect(r.ok).toBe(true);
    expect(update()!.payload).not.toHaveProperty('chat_tag_id');
  });

  it.each([
    ['not_confident', judged({ mainP: 0.3 }), chatRow()],
    ['not_confident', judged({ mainId: null }), chatRow()],
    [
      'dismissed',
      judged({}),
      chatRow({ tag_suggestion_dismissed_id: 'tag-a' }),
    ],
    ['same_as_current', judged({}), chatRow({ chat_tag_id: 'tag-a' })],
  ])('%s: no suggestion, the stale one is cleared', async (reason, j, chat) => {
    h.insights.mockResolvedValue(j);
    h.responses['conversations:select'] = chat;
    const r = await suggest();
    expect(r).toEqual({ ok: true, suggestion: null, reason });
    expect(update()!.payload).toEqual({
      suggested_chat_tag_id: null,
      suggested_chat_sub_tag_id: null,
      suggested_tag_p: null,
      suggested_tag_at: null,
      suggestion_basis_at: BASIS,
    });
  });

  it('no_tags: the workspace has no main tags, nothing asked or written', async () => {
    h.responses['chat_tags:select'] = { data: [], error: null };
    expect(await suggest()).toEqual({
      ok: true,
      suggestion: null,
      reason: 'no_tags',
    });
    expect(h.insights).not.toHaveBeenCalled();
    expect(update()).toBeUndefined();
  });

  it('no_message: no customer message in the chat', async () => {
    h.context = [{ role: 'assistant', content: 'Hello from Taamul' }];
    expect(await suggest()).toEqual({
      ok: true,
      suggestion: null,
      reason: 'no_message',
    });
    expect(h.insights).not.toHaveBeenCalled();
    expect(update()).toBeUndefined();
  });

  it('unavailable: Jev not available for the account', async () => {
    h.available = false;
    expect(await suggest()).toEqual({ ok: false, reason: 'unavailable' });
    h.available = true;
    h.layer = false;
    expect(await suggest()).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.calls).toEqual([]);
  });

  it('off: tag suggestions switched off', async () => {
    h.settings = settings({ tagSuggestMode: 'off' });
    expect(await suggest()).toEqual({ ok: false, reason: 'off' });
    expect(h.calls).toEqual([]);
  });

  it('error: a failed judgment stores nothing', async () => {
    h.insights.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 4000,
    });
    expect(await suggest()).toEqual({ ok: false, reason: 'error' });
    expect(update()).toBeUndefined();
  });

  it('error: a missing chat or a database failure, never a throw', async () => {
    h.responses['conversations:select'] = { data: null, error: null };
    expect(await suggest()).toEqual({ ok: false, reason: 'error' });
    h.responses['conversations:select'] = chatRow();
    h.responses['conversations:update'] = {
      data: null,
      error: { message: 'down' },
    };
    expect(await suggest()).toEqual({ ok: false, reason: 'error' });
    h.insights.mockRejectedValue(new Error('boom'));
    expect(await suggest()).toEqual({ ok: false, reason: 'error' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[insights]'),
      expect.any(String)
    );
  });
});
