import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

import { loadAiConfig } from './config';

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
};

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull();
  });

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    });
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect(config!.apiKey).toBe('plain:enc-key');
  });

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false })
    ).toBeNull();
  });
});

describe('loadAiConfig gate columns (migration 052)', () => {
  it('defaults every gate to off when the columns are absent', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    });
    expect(config).toMatchObject({
      escalationKeywords: [],
      retrievalMinScore: null,
      strictGrounding: false,
      handoffMessage: null,
    });
  });

  it('maps the gate columns when present', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ROW,
        escalation_keywords: ['refund', 'شكوى'],
        retrieval_min_score: 0.4,
        strict_grounding: true,
        handoff_message: '  A specialist will be in touch.  ',
      }),
      'acct',
      { requireActive: false }
    );
    expect(config).toMatchObject({
      escalationKeywords: ['refund', 'شكوى'],
      retrievalMinScore: 0.4,
      strictGrounding: true,
      handoffMessage: 'A specialist will be in touch.',
    });
  });
});

describe('loadAiConfig AI agent v2 columns (migration 077)', () => {
  it('reads a pre-077 database as routing off, no tiers, pause and retry on', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    });
    expect(config).toMatchObject({
      modelSmall: null,
      modelLarge: null,
      modelRouting: false,
      pauseOnAgentReply: true,
      autoResumeMinutes: null,
      guardrailRetry: true,
    });
  });

  it('maps the columns when present', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ROW,
        model_small: ' gpt-5.4-nano ',
        model_large: 'gpt-5.5',
        model_routing: true,
        pause_on_agent_reply: false,
        auto_resume_minutes: 240,
        guardrail_retry: false,
      }),
      'acct',
      { requireActive: false }
    );
    expect(config).toMatchObject({
      modelSmall: 'gpt-5.4-nano',
      modelLarge: 'gpt-5.5',
      modelRouting: true,
      pauseOnAgentReply: false,
      autoResumeMinutes: 240,
      guardrailRetry: false,
    });
  });

  it('reads a blank tier model as null', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...ROW, model_small: '  ', model_large: '' }),
      'acct',
      { requireActive: false }
    );
    expect(config).toMatchObject({ modelSmall: null, modelLarge: null });
  });
});
