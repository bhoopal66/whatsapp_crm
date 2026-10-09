import { describe, expect, it } from 'vitest';

import {
  MASKED_KEY,
  aiConfigFormFromResponse,
  emptyAiConfigForm,
  isAiConfigFormDirty,
  type AiConfigFormValues,
} from './config-form';

const loaded = aiConfigFormFromResponse({
  configured: true,
  provider: 'anthropic',
  model: 'claude-x',
  has_key: true,
  is_active: true,
  auto_reply_enabled: true,
  escalation_keywords: ['refund', 'lawyer'],
  retrieval_min_score: 0.4,
  auto_resume_minutes: 60,
});

// A different value of the same type for every field.
const other: { [K in keyof AiConfigFormValues]: AiConfigFormValues[K] } = {
  provider: 'openai',
  model: 'm2',
  apiKey: 'sk-new',
  keyEdited: true,
  embeddingsKey: 'sk-e',
  embeddingsKeyEdited: true,
  systemPrompt: 'be nice',
  isActive: false,
  autoReplyEnabled: false,
  autoReplyCampaignOnly: true,
  maxPerConversation: 7,
  handoffAgentId: 'u1',
  escalationKeywords: 'refund',
  retrievalMinScore: '0.5',
  strictGrounding: true,
  handoffMessage: 'hi',
  modelSmall: 's2',
  modelLarge: 'l2',
  modelRouting: false,
  pauseOnAgentReply: false,
  replyOnAllNumbers: true,
  autoResumeMinutes: 30,
  guardrailRetry: false,
};

describe('aiConfigFormFromResponse', () => {
  it('reads the response into form values', () => {
    expect(loaded.provider).toBe('anthropic');
    expect(loaded.apiKey).toBe(MASKED_KEY);
    expect(loaded.keyEdited).toBe(false);
    expect(loaded.escalationKeywords).toBe('refund\nlawyer');
    expect(loaded.retrievalMinScore).toBe('0.4');
    expect(loaded.autoResumeMinutes).toBe(60);
    expect(loaded.guardrailRetry).toBe(true);
    expect(loaded.modelRouting).toBe(true);
  });
});

describe('isAiConfigFormDirty', () => {
  it('is clean for an identical copy', () => {
    expect(isAiConfigFormDirty(loaded, { ...loaded })).toBe(false);
    expect(isAiConfigFormDirty(emptyAiConfigForm(), emptyAiConfigForm())).toBe(
      false
    );
  });

  it.each(Object.keys(other) as (keyof AiConfigFormValues)[])(
    'is dirty when %s changes',
    (field) => {
      const current = { ...loaded, [field]: other[field] };
      expect(current[field]).not.toEqual(loaded[field]);
      expect(isAiConfigFormDirty(loaded, current)).toBe(true);
    }
  );
});
