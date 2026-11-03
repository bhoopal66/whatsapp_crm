import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/ai/draft: the thread goes to the model as one transcript
// (lib/ai/draft-prompt), with the campaign the customer answers and, when
// the agent has typed something, that text as what the reply must say.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  retrieveKnowledge: vi.fn(),
  loadCampaignContext: vi.fn(),
  logAiUsage: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: mocks.retrieveKnowledge,
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  loadCampaignContext: mocks.loadCampaignContext,
}));
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }));

import { POST } from './route';

const CONV = 'conv-1';

type Result = { data: unknown; error: unknown };

function fakeClient(results: Record<string, Result>) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(results[table] ?? { data: null, error: null });
      for (const method of ['select', 'eq', 'order']) {
        builder[method] = () => builder;
      }
      builder.maybeSingle = take;
      builder.limit = take;
      return builder;
    },
  };
}

const ROWS = [
  {
    sender_type: 'customer',
    content_type: 'text',
    content_text: 'What documents do you need?',
    created_at: '2026-11-03T08:05:00Z',
  },
  {
    sender_type: 'agent',
    content_type: 'template',
    content_text: 'Personal loans from 4.99%',
    created_at: '2026-11-03T08:01:00Z',
  },
];

function setup(
  conversation: unknown = {
    id: CONV,
    campaign_broadcast_id: 'bc-1',
    contact: { name: 'Sara' },
  },
  rows: unknown[] = ROWS
) {
  mocks.requireRole.mockResolvedValue({
    supabase: fakeClient({
      conversations: { data: conversation, error: null },
      messages: { data: rows, error: null },
    }),
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  });
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/ai/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function sentContent(): string {
  const args = mocks.generateReply.mock.calls[0][0];
  expect(args.messages).toHaveLength(1);
  return args.messages[0].content as string;
}

describe('POST /api/ai/draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
    mocks.loadAiConfig.mockResolvedValue({
      provider: 'anthropic',
      model: 'm',
      systemPrompt: null,
    });
    mocks.retrieveKnowledge.mockResolvedValue([]);
    mocks.loadCampaignContext.mockResolvedValue({
      name: 'Loans Nov',
      body: 'Personal loans from 4.99%',
    });
    mocks.generateReply.mockResolvedValue({
      text: 'Hi Sara, we need your salary certificate.',
      handoff: false,
      usage: null,
    });
  });

  it('drafts from the transcript, the campaign and the customer name', async () => {
    const res = await post({ conversation_id: CONV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draft: 'Hi Sara, we need your salary certificate.',
    });
    const text = sentContent();
    expect(text).toContain('Customer: What documents do you need?');
    expect(text).toContain('(template message) Personal loans from 4.99%');
    expect(text).toContain('"Sara"');
    expect(text).not.toContain('<agent_input>');
    expect(mocks.loadCampaignContext).toHaveBeenCalledWith(
      {},
      'account-1',
      'bc-1'
    );
    const { systemPrompt } = mocks.generateReply.mock.calls[0][0];
    expect(systemPrompt).toContain('Loans Nov');
    expect(mocks.retrieveKnowledge.mock.calls[0][3]).toBe(
      'What documents do you need?'
    );
  });

  it('writes the reply from what the agent typed', async () => {
    const res = await post({
      conversation_id: CONV,
      typed: '  salary cert and 3 months bank statement ',
    });
    expect(res.status).toBe(200);
    expect(sentContent()).toContain(
      '<agent_input>\nsalary cert and 3 months bank statement\n</agent_input>'
    );
    expect(mocks.retrieveKnowledge.mock.calls[0][3]).toBe(
      'What documents do you need?\nsalary cert and 3 months bank statement'
    );
  });

  it('ignores a typed value that is not a string', async () => {
    await post({ conversation_id: CONV, typed: { evil: true } });
    expect(sentContent()).not.toContain('<agent_input>');
  });

  it('skips the campaign lookup for a thread with no campaign', async () => {
    setup({ id: CONV, campaign_broadcast_id: null, contact: null });
    await post({ conversation_id: CONV });
    expect(mocks.loadCampaignContext).not.toHaveBeenCalled();
  });

  it('refuses an empty thread with nothing typed, without calling the model', async () => {
    setup(undefined, []);
    const res = await post({ conversation_id: CONV });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_messages');
    expect(mocks.generateReply).not.toHaveBeenCalled();
  });

  it('drafts on an empty thread when the agent typed something', async () => {
    setup(undefined, []);
    const res = await post({ conversation_id: CONV, typed: 'welcome them' });
    expect(res.status).toBe(200);
    expect(sentContent()).toContain('There are no messages');
  });

  it('answers 404 for a conversation the caller cannot see', async () => {
    setup(null);
    const res = await post({ conversation_id: CONV });
    expect(res.status).toBe(404);
    expect(mocks.generateReply).not.toHaveBeenCalled();
  });
});
