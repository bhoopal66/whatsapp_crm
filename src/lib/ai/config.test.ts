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

describe('loadAiConfig reply_on_all_numbers (migration 079)', () => {
  it('reads the switch, absent as off', async () => {
    const opts = { requireActive: false };
    expect(
      (await loadAiConfig(dbReturning(ROW), 'acct', opts))!.replyOnAllNumbers
    ).toBe(false);
    expect(
      (await loadAiConfig(
        dbReturning({ ...ROW, reply_on_all_numbers: true }),
        'acct',
        opts
      ))!.replyOnAllNumbers
    ).toBe(true);
  });

  it('loads as before 079 when the column does not exist yet', async () => {
    const selects: string[] = [];
    const chain = {
      from: () => chain,
      select: (cols: string) => {
        selects.push(cols);
        return chain;
      },
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve(
          selects.at(-1)!.includes('reply_on_all_numbers')
            ? {
                data: null,
                error: {
                  code: '42703',
                  message:
                    'column ai_configs.reply_on_all_numbers does not exist',
                },
              }
            : { data: ROW, error: null }
        ),
    };
    const config = await loadAiConfig(
      chain as unknown as SupabaseClient,
      'acct',
      { requireActive: false }
    );
    expect(selects).toHaveLength(2);
    expect(config!.replyOnAllNumbers).toBe(false);
  });

  it('still throws any other read error', async () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({ data: null, error: { code: '42501', message: 'x' } }),
    };
    await expect(
      loadAiConfig(chain as unknown as SupabaseClient, 'acct')
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('loadAiConfig approved answers (migration 081)', () => {
  const opts = { requireActive: false };

  it('reads the three fields, absent as generate / 0.8 / null', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct', opts)).toMatchObject({
      answerMode: 'generate',
      approvedMinScore: 0.8,
      sensitiveDataReply: null,
    });
    expect(
      await loadAiConfig(
        dbReturning({
          ...ROW,
          answer_mode: 'approved',
          approved_min_score: 0.9,
          sensitive_data_reply: '  Please do not share that here.  ',
        }),
        'acct',
        opts
      )
    ).toMatchObject({
      answerMode: 'approved',
      approvedMinScore: 0.9,
      sensitiveDataReply: 'Please do not share that here.',
    });
  });

  it('reads an unknown mode as generate and a blank reply as off', async () => {
    expect(
      await loadAiConfig(
        dbReturning({ ...ROW, answer_mode: 'x', sensitive_data_reply: '  ' }),
        'acct',
        opts
      )
    ).toMatchObject({ answerMode: 'generate', sensitiveDataReply: null });
  });

  it('retries with the 079 columns when 081 is not applied yet', async () => {
    const selects: string[] = [];
    const chain = {
      from: () => chain,
      select: (cols: string) => {
        selects.push(cols);
        return chain;
      },
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve(
          selects.at(-1)!.includes('answer_mode')
            ? {
                data: null,
                error: {
                  code: 'PGRST204',
                  message: "Could not find the 'answer_mode' column",
                },
              }
            : { data: { ...ROW, reply_on_all_numbers: true }, error: null }
        ),
    };
    const config = await loadAiConfig(
      chain as unknown as SupabaseClient,
      'acct',
      opts
    );
    expect(selects).toHaveLength(2);
    expect(selects[1]).toContain('reply_on_all_numbers');
    expect(selects[1]).not.toContain('answer_mode');
    expect(config).toMatchObject({
      replyOnAllNumbers: true,
      answerMode: 'generate',
      approvedMinScore: 0.8,
      sensitiveDataReply: null,
    });
  });
});
