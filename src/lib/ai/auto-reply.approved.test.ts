import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiConfig } from './types';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

// Approved answers only (migration 081) and the sensitive-data warning,
// driven through `dispatchInboundToAiReply` with the module boundaries
// mocked, in the style of auto-reply.test.ts.
const h = vi.hoisted(() => ({
  decisionLayer: null as unknown,
  kbSelect: vi.fn(),
  shortlist: vi.fn(),
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  routeMessage: vi.fn(),
  engineSendText: vi.fn(),
  resolveChannelForSurface: vi.fn(),
  runTriageGate: vi.fn(),
  runGuardrailGate: vi.fn(),
  markOptedOut: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    claim: true as boolean,
    rpcCalls: [] as string[],
    handoffs: [] as Record<string, unknown>[],
    outcomes: [] as Record<string, unknown>[],
    gaps: [] as Record<string, unknown>[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({
  retrieveKnowledgeScored: h.retrieveKnowledge,
}));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./router')>();
  h.routeMessage.mockImplementation(actual.routeMessage);
  return { ...actual, routeMessage: h.routeMessage };
});
vi.mock('./typesafe-gates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./typesafe-gates')>()),
  runTriageGate: h.runTriageGate,
  runPassageGate: async (_ref: unknown, a: { retrieval: unknown }) => ({
    knowledge: [],
    conflicts: [],
    evidence: [],
    retrieval: a.retrieval,
  }),
  runGuardrailGate: h.runGuardrailGate,
  enforcedPartnerBanks: async () => null,
}));
vi.mock('./opt-out', () => ({ markOptedOut: h.markOptedOut }));
vi.mock('./usage', () => ({ logAiUsage: vi.fn() }));
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () => h.decisionLayer,
}));
vi.mock('@/lib/kb/shortlist', () => ({
  shortlistApprovedAnswers: h.shortlist,
}));
vi.mock('@/lib/flows/channel-send', () => ({
  engineSendText: h.engineSendText,
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  resolveChannelForSurface: h.resolveChannelForSurface,
  resolveAiReplyChannel: vi.fn(),
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      // One permissive chain: every filter returns it; reads resolve to
      // the conversation (or nothing), writes are captured by table.
      let payload: Record<string, unknown> | null = null;
      const done = () => {
        if (table === 'conversations' && payload) {
          if ('ai_last_outcome' in payload) h.state.outcomes.push(payload);
          else h.state.handoffs.push(payload);
        }
        return {
          data: table === 'conversations' && payload ? [{ id: 'conv-1' }] : [],
          error: null,
        };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'conversations' ? h.state.conv : null,
            error: null,
          }),
        update: (p: Record<string, unknown>) => {
          payload = p;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'ai_knowledge_gaps') h.state.gaps.push(row);
          return Promise.resolve({ error: null });
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve(done()).then(ok, fail),
      };
      return chain;
    },
    rpc: (name: string) => {
      h.state.rpcCalls.push(name);
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundProvider: 'meta' as const,
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyCampaignOnly: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    escalationKeywords: [],
    retrievalMinScore: null,
    strictGrounding: false,
    handoffMessage: 'A colleague will reply shortly.',
    modelSmall: null,
    modelLarge: null,
    modelRouting: false,
    pauseOnAgentReply: true,
    autoResumeMinutes: null,
    guardrailRetry: true,
    replyOnAllNumbers: false,
    answerMode: 'approved',
    approvedMinScore: 0.8,
    sensitiveDataReply: null,
    ...overrides,
  };
}

const ROW = {
  id: 'kb-1',
  ref: 'KB-010',
  question: 'What documents do I need for a personal loan?',
  answer_en:
    'You need your Emirates ID, salary certificate and bank statements.',
  answer_ar: 'تحتاج إلى الهوية الإماراتية وشهادة الراتب وكشوف الحساب.',
  handoff_after: false,
  rank: 0.5,
};
const OTHER = {
  ...ROW,
  id: 'kb-2',
  ref: 'KB-020',
  question: 'How long does approval take?',
  answer_en: 'Approval usually takes three working days.',
};

function judged(
  scores: [number, number][],
  handoff: Partial<{ pricing: number; legal: number; angry: number }> = {}
) {
  return {
    ok: true as const,
    handoff: { pricing: 0.05, legal: 0.05, angry: 0.05, ...handoff },
    candidates: scores.map(([answersFully, sameIntent], index) => ({
      index,
      answersFully,
      sameIntent,
    })),
    latencyMs: 40,
  };
}

function customerSays(text: string) {
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: text },
  ]);
}

/** The `ai_last_outcome_detail` of the dispatch's single record. */
const lastDetail = () =>
  h.state.outcomes.at(-1)?.ai_last_outcome_detail as string | null;

process.env.AI_BURST_WAIT_MS = '0';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitForTests();
  h.decisionLayer = { kbSelect: h.kbSelect };
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  };
  h.state.claim = true;
  h.state.rpcCalls = [];
  h.state.handoffs = [];
  h.state.outcomes = [];
  h.state.gaps = [];
  h.loadAiConfig.mockResolvedValue(aiConfig());
  customerSays('What documents do I need for a personal loan?');
  h.shortlist.mockResolvedValue([ROW, OTHER]);
  h.kbSelect.mockResolvedValue(
    judged([
      [0.92, 0.95],
      [0.2, 0.3],
    ])
  );
  h.retrieveKnowledge.mockResolvedValue({
    excerpts: [],
    passages: [],
    bestSimilarity: null,
    hasKnowledgeBase: false,
  });
  h.generateReply.mockResolvedValue({
    text: 'Generated',
    handoff: false,
    usage: null,
  });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.resolveChannelForSurface.mockResolvedValue({
    id: 'ch-meta',
    provider: 'meta',
  });
  h.runTriageGate.mockResolvedValue({
    handoff: null,
    restricted: false,
    promptNotes: [],
  });
  h.runGuardrailGate.mockResolvedValue({ outcome: 'send' });
  h.markOptedOut.mockResolvedValue(true);
});

describe('dispatchInboundToAiReply — approved answers only', () => {
  it('sends the best approved answer verbatim above the threshold', async () => {
    expect(await dispatchInboundToAiReply(ARGS)).toBe('replied');
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: ROW.answer_en,
        aiGenerated: true,
        surface: 'ai_reply',
      })
    );
    expect(h.state.rpcCalls).toEqual(['claim_ai_reply_slot']);
    expect(h.state.outcomes.at(-1)?.ai_last_outcome).toBe('replied');
    expect(lastDetail()).toBe('Approved answer KB-010 (0.92)');
    expect(h.state.handoffs).toEqual([]);
  });

  it('judges the open question against the shortlist’s English answers', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.shortlist).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'What documents do I need for a personal loan?'
    );
    const input = h.kbSelect.mock.calls[0][0];
    expect(input).toMatchObject({
      accountId: 'acct-1',
      message: 'What documents do I need for a personal loan?',
      candidates: [
        { question: ROW.question, answer: ROW.answer_en },
        { question: OTHER.question, answer: OTHER.answer_en },
      ],
    });
    expect(input.deadlineMs).toBeGreaterThanOrEqual(1_500);
    expect(input.deadlineMs).toBeLessThanOrEqual(6_000);
  });

  it('never calls the model, the router or the guardrail', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.routeMessage).not.toHaveBeenCalled();
    expect(h.retrieveKnowledge).not.toHaveBeenCalled();
    expect(h.runGuardrailGate).not.toHaveBeenCalled();
    expect(h.runTriageGate).toHaveBeenCalledTimes(1);
  });

  it('answers an Arabic message in Arabic', async () => {
    customerSays('ما هي المستندات المطلوبة للقرض الشخصي؟');
    expect(await dispatchInboundToAiReply(ARGS)).toBe('replied');
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: ROW.answer_ar })
    );
  });

  it('hands off an Arabic message whose answer has no Arabic text', async () => {
    customerSays('ما هي المستندات المطلوبة للقرض الشخصي؟');
    h.shortlist.mockResolvedValue([{ ...ROW, answer_ar: null }, OTHER]);
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('no_knowledge');
    // Only the hand-off message reaches the customer.
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.engineSendText.mock.calls[0][0].text).toBe(
      'A colleague will reply shortly.'
    );
  });

  it('hands off below the threshold and logs the knowledge gap', async () => {
    h.kbSelect.mockResolvedValue(
      judged([
        [0.79, 0.95],
        [0.2, 0.3],
      ])
    );
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('no_knowledge');
    expect(h.state.gaps).toEqual([
      expect.objectContaining({
        question: 'What documents do I need for a personal loan?',
      }),
    ]);
    expect(lastDetail()).toBe(
      'no_knowledge: Best approved answer KB-010 scored 0.79 (needs 0.80)'
    );
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
      'A colleague will reply shortly.',
    ]);
  });

  it('hands off with reason kb on a pricing request', async () => {
    h.kbSelect.mockResolvedValue(
      judged(
        [
          [0.95, 0.95],
          [0.2, 0.3],
        ],
        { pricing: 0.5 }
      )
    );
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('kb');
    expect(h.state.gaps).toEqual([]);
    expect(h.engineSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: ROW.answer_en })
    );
  });

  it('sends nothing but the hand-off message when the check is unavailable', async () => {
    h.kbSelect.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 6000,
    });
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('error');
    expect(lastDetail()).toBe(
      'error: Approved-answer check unavailable (TIMEOUT)'
    );
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
      'A colleague will reply shortly.',
    ]);
  });

  it('hands off when TypeSafe is not set up at all', async () => {
    h.decisionLayer = null;
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(lastDetail()).toBe(
      'error: Approved-answer check unavailable (DISABLED)'
    );
    expect(h.engineSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: ROW.answer_en })
    );
  });

  it('hands off when no approved answer is shortlisted', async () => {
    h.shortlist.mockResolvedValue([]);
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.kbSelect).not.toHaveBeenCalled();
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('no_knowledge');
    expect(h.state.gaps).toHaveLength(1);
    expect(lastDetail()).toBe('no_knowledge: No approved answer matched');
  });

  it('hands off with reason error when the shortlist lookup fails', async () => {
    h.shortlist.mockRejectedValue(new Error('kb_shortlist failed: boom'));
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.kbSelect).not.toHaveBeenCalled();
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('error');
    expect(lastDetail()).toBe(
      'error: Approved answers lookup failed: kb_shortlist failed: boom'
    );
  });

  it('sends a hand-off-after answer, then hands off with no second message', async () => {
    h.shortlist.mockResolvedValue([{ ...ROW, handoff_after: true }, OTHER]);
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
      ROW.answer_en,
    ]);
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('kb');
    expect(lastDetail()).toBe(
      'kb: Approved answer KB-010 (0.92) hands the chat to a person'
    );
  });

  it('hands off when the budget has no room for the judgment', async () => {
    let t = 0;
    const now = () => (t += 50_000);
    expect(await dispatchInboundToAiReply({ ...ARGS, now })).toBe('handed_off');
    expect(h.kbSelect).not.toHaveBeenCalled();
    expect(lastDetail()).toBe('error: AI ran out of time');
  });

  it('still hands off on a triage hand-off, before the shortlist', async () => {
    h.runTriageGate.mockResolvedValue({
      handoff: { detail: 'opt-out', farewell: false, optOut: 'record' },
      restricted: false,
      promptNotes: [],
    });
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.markOptedOut).toHaveBeenCalled();
    expect(h.shortlist).not.toHaveBeenCalled();
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('triage');
  });
});

describe('dispatchInboundToAiReply — sensitive-data warning', () => {
  const WARNING = 'Please do not share ID or card numbers here.';

  it.each(['approved', 'generate'] as const)(
    'sends only the warning in %s mode',
    async (answerMode) => {
      h.loadAiConfig.mockResolvedValue(
        aiConfig({ answerMode, sensitiveDataReply: WARNING })
      );
      customerSays('my id is 784-1990-1234567-1');
      expect(await dispatchInboundToAiReply(ARGS)).toBe('replied');
      expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
        WARNING,
      ]);
      expect(h.state.rpcCalls).toEqual(['claim_ai_reply_slot']);
      expect(h.runTriageGate).not.toHaveBeenCalled();
      expect(h.routeMessage).not.toHaveBeenCalled();
      expect(h.generateReply).not.toHaveBeenCalled();
      expect(h.shortlist).not.toHaveBeenCalled();
      expect(h.kbSelect).not.toHaveBeenCalled();
      expect(lastDetail()).toBe('Sensitive-data warning sent');
    }
  );

  it('is off when no warning is configured', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ answerMode: 'generate' }));
    customerSays('my id is 784-1990-1234567-1');
    expect(await dispatchInboundToAiReply(ARGS)).toBe('replied');
    expect(h.runTriageGate).toHaveBeenCalled();
    // Generate mode still routes: the spy sees the router when it runs.
    expect(h.routeMessage).toHaveBeenCalled();
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
      'Generated',
    ]);
  });

  it('leaves a message without an identifier to the normal path', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ sensitiveDataReply: WARNING }));
    expect(await dispatchInboundToAiReply(ARGS)).toBe('replied');
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
      ROW.answer_en,
    ]);
  });

  it('hands off when the warning fails to send', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ sensitiveDataReply: WARNING }));
    customerSays('card 4111 1111 1111 1111');
    h.engineSendText.mockRejectedValue(new Error('gateway down'));
    expect(await dispatchInboundToAiReply(ARGS)).toBe('handed_off');
    expect(h.state.handoffs[0]?.ai_handoff_reason).toBe('error');
    expect(h.state.outcomes.at(-1)?.ai_last_outcome).toBe('error');
  });
});
