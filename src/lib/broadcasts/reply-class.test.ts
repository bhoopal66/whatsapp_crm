import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// classifyCampaignReply / tagInterestedReply (migration 148). A small
// recording Supabase fake stands in for PostgREST; Jev, the settings
// and the chat-tag write are mocked at their module boundaries.
// ============================================================

type Result = { data: unknown; error: unknown };
interface Call {
  table: string;
  op: 'select' | 'update';
  payload?: unknown;
  filters: [string, string, unknown][];
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  available: true,
  settings: { replyClassEnabled: true, replyInterestedTagId: 'tag-int' } as {
    replyClassEnabled: boolean;
    replyInterestedTagId: string | null;
  },
  layer: null as unknown,
  replyClass: vi.fn(),
  template: { body_text: 'Hi {{1}}, our card offer is open.' } as {
    body_text: string;
  } | null,
  broadcast: {
    template_name: 'card_offer',
    template_language: 'en',
  } as unknown,
  recipient: { id: 'rec-1', template_params: ['Asha'] } as unknown,
  updateError: null as unknown,
  write: vi.fn(),
  dispatch: vi.fn(),
}));

function respond(call: Call): Result {
  if (call.op === 'update') return { data: null, error: h.updateError };
  if (call.table === 'broadcasts') return { data: h.broadcast, error: null };
  if (call.table === 'broadcast_recipients')
    return { data: h.recipient, error: null };
  return { data: null, error: null };
}

function fakeDb() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const run = () => {
        h.calls.push(call);
        return Promise.resolve(respond(call));
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (payload: unknown) => {
          call.op = 'update';
          call.payload = payload;
          return b;
        },
        maybeSingle: run,
        then: (res: (r: Result) => unknown, rej?: (e: unknown) => unknown) =>
          run().then(res, rej),
      };
      for (const f of ['eq', 'is'] as const)
        b[f] = (col: string, v: unknown) => {
          call.filters.push([f, col, v]);
          return b;
        };
      return b;
    },
  };
}

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => fakeDb() }));
vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => h.settings,
}));
vi.mock('@/lib/typesafe', () => ({ getDecisionLayer: () => h.layer }));
vi.mock('@/lib/whatsapp/template-body', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/template-body')>()),
  resolveTemplateRow: async () => ({
    row: h.template,
    malformed: false,
    language: 'en',
  }),
}));
vi.mock('@/lib/chat-tags/server', () => ({
  writeConversationChatTags: (...a: unknown[]) => h.write(...a),
}));
vi.mock('@/lib/automations/chat-tag-dispatch', () => ({
  dispatchChatTagSet: (...a: unknown[]) => h.dispatch(...a),
}));

import { classifyCampaignReply, tagInterestedReply } from './reply-class';

const input = {
  accountId: 'acct-1',
  recipientId: 'rec-1',
  broadcastId: 'bc-1',
  replyText: 'yes please',
  tappedButton: null,
  deadlineMs: 1500,
};

beforeEach(() => {
  h.calls = [];
  h.available = true;
  h.settings = { replyClassEnabled: true, replyInterestedTagId: 'tag-int' };
  h.replyClass
    .mockReset()
    .mockResolvedValue({ ok: true, cls: 'interested', p: 0.88, latencyMs: 5 });
  h.layer = { replyClass: h.replyClass };
  h.template = { body_text: 'Hi {{1}}, our card offer is open.' };
  h.broadcast = { template_name: 'card_offer', template_language: 'en' };
  h.recipient = { id: 'rec-1', template_params: ['Asha'] };
  h.updateError = null;
  h.write.mockReset();
  h.dispatch.mockReset().mockResolvedValue(undefined);
});

const updates = () => h.calls.filter((c) => c.op === 'update');

describe('classifyCampaignReply', () => {
  it('judges the rendered campaign message and stores the class', async () => {
    expect(await classifyCampaignReply(input)).toEqual({
      cls: 'interested',
      p: 0.88,
    });
    expect(h.replyClass).toHaveBeenCalledWith({
      accountId: 'acct-1',
      campaignMessage: 'Hi Asha, our card offer is open.',
      reply: 'yes please',
      tappedButton: null,
      deadlineMs: 1500,
    });
    const broadcastRead = h.calls.find((c) => c.table === 'broadcasts')!;
    expect(broadcastRead.filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
    const [u] = updates();
    expect(u!.table).toBe('broadcast_recipients');
    expect(u!.payload).toMatchObject({
      reply_class: 'interested',
      reply_class_p: 0.88,
      reply_classified_at: expect.any(String),
    });
    expect(u!.filters).toEqual([
      ['eq', 'id', 'rec-1'],
      ['eq', 'broadcast_id', 'bc-1'],
      ['is', 'reply_class', null],
    ]);
  });

  it('falls back to the bare body when no params were stored', async () => {
    h.recipient = { id: 'rec-1', template_params: null };
    await classifyCampaignReply(input);
    expect(h.replyClass.mock.calls[0]![0].campaignMessage).toBe(
      'Hi {{1}}, our card offer is open.'
    );
  });

  it.each([
    ['the switch is off', () => (h.settings.replyClassEnabled = false)],
    ['Jev is unavailable', () => (h.available = false)],
    ['the layer is off', () => (h.layer = null)],
  ])('does nothing when %s', async (_, arrange) => {
    arrange();
    expect(await classifyCampaignReply(input)).toBeNull();
    expect(h.replyClass).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('does nothing for a broadcast outside the account or with no template', async () => {
    h.broadcast = null;
    expect(await classifyCampaignReply(input)).toBeNull();
    h.broadcast = { template_name: 'card_offer', template_language: 'en' };
    h.template = null;
    expect(await classifyCampaignReply(input)).toBeNull();
    expect(h.replyClass).not.toHaveBeenCalled();
  });

  it('stores nothing when Jev fails', async () => {
    h.replyClass.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 1500,
    });
    expect(await classifyCampaignReply(input)).toBeNull();
    expect(updates()).toHaveLength(0);
  });

  it('never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.replyClass.mockRejectedValue(new Error('boom'));
    expect(await classifyCampaignReply(input)).toBeNull();
    h.replyClass.mockResolvedValue({ ok: true, cls: 'stop', p: 0.9 });
    h.updateError = { message: 'denied' };
    expect(await classifyCampaignReply(input)).toBeNull();
    err.mockRestore();
  });
});

describe('tagInterestedReply', () => {
  const args = {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    replyClass: { cls: 'interested' as const, p: 0.8 },
  };

  it('tags an untagged chat with onlyIfUntagged and runs chat_tag_set', async () => {
    const previous = { chat_tag_id: null, chat_sub_tag_id: null };
    const saved = { chat_tag_id: 'tag-int', chat_sub_tag_id: null };
    h.write.mockResolvedValue({
      ok: true,
      previous,
      saved,
      contactId: 'contact-1',
      conversationId: 'conv-1',
    });
    expect(await tagInterestedReply(args)).toBe('applied');
    expect(h.write).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      next: { chat_tag_id: 'tag-int', chat_sub_tag_id: null },
      onlyIfUntagged: true,
    });
    expect(h.dispatch).toHaveBeenCalledWith({
      accountId: 'acct-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      previous,
      saved,
    });
  });

  it('dispatches nothing when the chat was already tagged', async () => {
    const tags = { chat_tag_id: 'tag-person', chat_sub_tag_id: null };
    h.write.mockResolvedValue({
      ok: true,
      previous: tags,
      saved: tags,
      contactId: 'contact-1',
      conversationId: 'conv-1',
    });
    expect(await tagInterestedReply(args)).toBe('unchanged');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['no class', null],
    ['another class', { cls: 'question' as const, p: 0.95 }],
    ['an unsure interested', { cls: 'interested' as const, p: 0.69 }],
  ])('leaves the chat alone for %s', async (_, replyClass) => {
    expect(await tagInterestedReply({ ...args, replyClass })).toBe(
      'not_interested'
    );
    expect(h.write).not.toHaveBeenCalled();
  });

  it('leaves the chat alone when no tag is chosen', async () => {
    h.settings.replyInterestedTagId = null;
    expect(await tagInterestedReply(args)).toBe('no_tag');
    expect(h.write).not.toHaveBeenCalled();
  });
});
