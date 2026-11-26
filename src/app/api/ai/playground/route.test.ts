import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/ai/playground: the test chat registers its model call under
// its own transfer purpose, and a billed call that fails is still counted.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  retrieveKnowledgeScored: vi.fn(),
  logAiUsage: vi.fn(),
  logFailedAiUsage: vi.fn(),
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
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledgeScored: mocks.retrieveKnowledgeScored,
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/usage', () => ({
  logAiUsage: mocks.logAiUsage,
  logFailedAiUsage: mocks.logFailedAiUsage,
}));
vi.mock('@/lib/ai/auto-reply', () => ({ retrievalGateFailure: () => null }));

import { AiError } from '@/lib/ai/types';
import { POST } from './route';

function post() {
  return POST(
    new Request('http://localhost/api/ai/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What are the fees?' }],
      }),
    })
  );
}

describe('POST /api/ai/playground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: {},
      accountId: 'account-1',
      userId: 'user-1',
      role: 'agent',
    });
    mocks.loadAiConfig.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-m',
      systemPrompt: null,
      escalationKeywords: [],
      retrievalMinScore: null,
      strictGrounding: false,
    });
    mocks.retrieveKnowledgeScored.mockResolvedValue({ excerpts: [] });
    mocks.generateReply.mockResolvedValue({
      text: 'AED 1,500.',
      handoff: false,
      usage: null,
    });
    mocks.logAiUsage.mockResolvedValue(undefined);
    mocks.logFailedAiUsage.mockResolvedValue(undefined);
  });

  it('registers the call as the playground, not a reply, in the transfer register', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.generateReply.mock.calls[0][0].purpose).toBe('playground');
  });

  it('logs the usage of a billed call that failed, once, and still answers the error', async () => {
    const err = new AiError('cut off', {
      code: 'truncated',
      status: 502,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    mocks.generateReply.mockRejectedValue(err);
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('truncated');
    expect(mocks.logFailedAiUsage).toHaveBeenCalledTimes(1);
    const [, loggedErr, args] = mocks.logFailedAiUsage.mock.calls[0];
    expect(loggedErr).toBe(err);
    expect(args).toEqual({
      accountId: 'account-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-m',
    });
    expect(mocks.logAiUsage).not.toHaveBeenCalled();
  });
});
