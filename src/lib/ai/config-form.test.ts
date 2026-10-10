import { describe, expect, it } from 'vitest';

import {
  MASKED_KEY,
  aiConfigFormFromResponse,
  aiConfigRequestBody,
  applyAiSaveResult,
  applyKeyFieldEvent,
  buildAiSavePlan,
  emptyAiConfigForm,
  isAiConfigFormDirty,
  toggleSensitiveReply,
  willHaveEmbeddingsKey,
  type AiConfigFormValues,
  type AiSavedState,
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
  embeddingsKeyRemoved: true,
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
  answerMode: 'approved',
  approvedMinScore: 0.9,
  sensitiveReplyOn: true,
  sensitiveDataReply: 'careful',
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

describe('applyKeyFieldEvent', () => {
  // Both keys stored: the fields show the mask.
  const stored = aiConfigFormFromResponse({
    configured: true,
    provider: 'openai',
    model: 'gpt-x',
    has_key: true,
    has_embeddings_key: true,
  });
  const run = (
    field: 'apiKey' | 'embeddingsKey',
    events: Parameters<typeof applyKeyFieldEvent>[2][],
    from: AiConfigFormValues = stored
  ) => events.reduce((v, e) => applyKeyFieldEvent(v, field, e, true), from);

  it('focus then blur sends no key and leaves the form clean', () => {
    for (const field of ['apiKey', 'embeddingsKey'] as const) {
      // Checked while still focused too: Save can run from another tab.
      const focused = run(field, [{ type: 'focus' }]);
      const v = run(field, [{ type: 'blur' }], focused);
      for (const state of [focused, v]) {
        const body = JSON.parse(JSON.stringify(aiConfigRequestBody(state)));
        expect(body).not.toHaveProperty('api_key');
        expect(body).not.toHaveProperty('embeddings_api_key');
        expect(isAiConfigFormDirty(stored, state)).toBe(false);
      }
    }
  });

  it('a focused API key field alone is not an unsaved change', () => {
    const v = run('apiKey', [{ type: 'focus' }]);
    expect(isAiConfigFormDirty(stored, v)).toBe(false);
  });

  it('sends a typed key, without the mask it was typed into', () => {
    const typed = run('embeddingsKey', [
      { type: 'focus' },
      { type: 'input', value: `${MASKED_KEY}sk-emb` },
      { type: 'blur' },
    ]);
    expect(aiConfigRequestBody(typed).embeddings_api_key).toBe('sk-emb');
    expect(willHaveEmbeddingsKey(typed, true)).toBe(true);

    const api = run('apiKey', [{ type: 'input', value: ' sk-new ' }]);
    expect(aiConfigRequestBody(api).api_key).toBe('sk-new');
  });

  it('typing then clearing restores the mask on blur', () => {
    for (const field of ['apiKey', 'embeddingsKey'] as const) {
      const v = run(field, [
        { type: 'focus' },
        { type: 'input', value: 'sk-x' },
        { type: 'input', value: '' },
        { type: 'blur' },
      ]);
      expect(v[field]).toBe(MASKED_KEY);
      expect(isAiConfigFormDirty(stored, v)).toBe(false);
      const body = aiConfigRequestBody(v);
      expect(body.api_key).toBeUndefined();
      expect(body.embeddings_api_key).toBeUndefined();
    }
  });

  it('a blank field with no stored key stays blank on blur', () => {
    const blank = emptyAiConfigForm();
    const v = [
      { type: 'input', value: 'sk' } as const,
      { type: 'input', value: '' } as const,
      { type: 'blur' } as const,
    ].reduce((x, e) => applyKeyFieldEvent(x, 'apiKey', e, false), blank);
    expect(v.apiKey).toBe('');
    expect(aiConfigRequestBody(v).api_key).toBeUndefined();
  });

  it('a blank edited field never clears a key', () => {
    const v = run('embeddingsKey', [{ type: 'input', value: '' }]);
    expect(v.embeddingsKeyEdited).toBe(true);
    expect(aiConfigRequestBody(v).embeddings_api_key).toBeUndefined();
  });

  it('Remove key sends null for the embeddings key', () => {
    const v = run('embeddingsKey', [{ type: 'remove' }]);
    expect(aiConfigRequestBody(v).embeddings_api_key).toBeNull();
    expect(isAiConfigFormDirty(stored, v)).toBe(true);
    expect(willHaveEmbeddingsKey(v, true)).toBe(false);
    // Focusing and leaving the emptied field does not undo it.
    const after = run(
      'embeddingsKey',
      [{ type: 'focus' }, { type: 'blur' }],
      v
    );
    expect(aiConfigRequestBody(after).embeddings_api_key).toBeNull();
  });

  it('a key typed after Remove key replaces the stored one', () => {
    const v = run('embeddingsKey', [
      { type: 'remove' },
      { type: 'input', value: 'sk-new' },
    ]);
    expect(aiConfigRequestBody(v).embeddings_api_key).toBe('sk-new');
  });

  it('Remove does nothing to the API key', () => {
    expect(run('apiKey', [{ type: 'remove' }])).toBe(stored);
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

describe('buildAiSavePlan', () => {
  const DEFAULT = 'n-default';
  const only = { ...loaded, replyOnAllNumbers: false };
  const every = { ...loaded, replyOnAllNumbers: true };
  const savedOnly = (route: string | null): AiSavedState => ({
    configured: true,
    values: only,
    route,
  });

  it('sends nothing and is clean when nothing changed', () => {
    expect(
      buildAiSavePlan(savedOnly('n2'), { values: only, route: 'n2' }, DEFAULT)
    ).toEqual({ config: null, aiReplyRoute: null, dirty: false });
  });

  it('POSTs only for a config-only change', () => {
    const values = { ...only, systemPrompt: 'be brief' };
    const plan = buildAiSavePlan(
      savedOnly('n2'),
      { values, route: 'n2' },
      DEFAULT
    );
    expect(plan.config).toEqual(aiConfigRequestBody(values));
    expect(plan.aiReplyRoute).toBeNull();
    expect(plan.dirty).toBe(true);
  });

  it('PUTs only for a route-only change', () => {
    const plan = buildAiSavePlan(
      savedOnly('n2'),
      { values: only, route: 'n3' },
      DEFAULT
    );
    expect(plan).toEqual({ config: null, aiReplyRoute: 'n3', dirty: true });
  });

  it('never PUTs for "Every number"', () => {
    for (const route of [null, 'n2', 'n3']) {
      const plan = buildAiSavePlan(
        { configured: true, values: only, route: null },
        { values: every, route },
        DEFAULT
      );
      expect(plan.aiReplyRoute).toBeNull();
      expect(plan.config).not.toBeNull();
    }
    const unchanged = buildAiSavePlan(
      { configured: true, values: every, route: null },
      { values: every, route: 'n3' },
      DEFAULT
    );
    expect(unchanged).toEqual({
      config: null,
      aiReplyRoute: null,
      dirty: false,
    });
  });

  it('pins the default number when "Only on" has no saved route', () => {
    // Switching from "Every number" to "Only on".
    const switched = buildAiSavePlan(
      { configured: true, values: every, route: null },
      { values: only, route: null },
      DEFAULT
    );
    expect(switched.aiReplyRoute).toBe(DEFAULT);
    expect(switched.config).not.toBeNull();

    // A legacy "Only on" account saving an unrelated change.
    const values = { ...only, systemPrompt: 'be brief' };
    const legacy = buildAiSavePlan(
      savedOnly(null),
      { values, route: null },
      DEFAULT
    );
    expect(legacy.aiReplyRoute).toBe(DEFAULT);
  });

  it('does not show a legacy "Only on" account as dirty on load', () => {
    const plan = buildAiSavePlan(
      savedOnly(null),
      { values: only, route: null },
      DEFAULT
    );
    expect(plan.dirty).toBe(false);
    // ...nor once the default number is picked explicitly.
    expect(
      buildAiSavePlan(
        savedOnly(null),
        { values: only, route: DEFAULT },
        DEFAULT
      ).dirty
    ).toBe(false);
    // Picking another number is an edit.
    expect(
      buildAiSavePlan(savedOnly(null), { values: only, route: 'n3' }, DEFAULT)
        .dirty
    ).toBe(true);
  });

  it('always POSTs a first save', () => {
    const plan = buildAiSavePlan(
      { configured: false, values: only, route: null },
      { values: only, route: null },
      DEFAULT
    );
    expect(plan.config).toEqual(aiConfigRequestBody(only));
  });
});

describe('applyAiSaveResult', () => {
  const values = { ...loaded, replyOnAllNumbers: false, systemPrompt: 'x' };
  const saved: AiSavedState = {
    configured: true,
    values: { ...loaded, replyOnAllNumbers: false },
    route: 'n2',
  };
  const current = { values, route: 'n3' };

  it('advances both when both requests succeed', () => {
    const plan = buildAiSavePlan(saved, current, 'n1');
    const next = applyAiSaveResult(saved, current, plan, {
      configSaved: true,
      routeSaved: true,
    });
    expect(next).toEqual({ configured: true, values, route: 'n3' });
    expect(buildAiSavePlan(next, current, 'n1').dirty).toBe(false);
  });

  it('stays dirty after a failed PUT, and the retry only PUTs', () => {
    const plan = buildAiSavePlan(saved, current, 'n1');
    expect(plan.config).not.toBeNull();
    expect(plan.aiReplyRoute).toBe('n3');
    const next = applyAiSaveResult(saved, current, plan, {
      configSaved: true,
      routeSaved: false,
    });
    expect(next.route).toBe('n2');
    const retry = buildAiSavePlan(next, current, 'n1');
    expect(retry).toEqual({ config: null, aiReplyRoute: 'n3', dirty: true });
  });

  it('keeps a legacy no-route account pinning on retry', () => {
    const legacy: AiSavedState = { ...saved, route: null };
    const cur = { values, route: null };
    const plan = buildAiSavePlan(legacy, cur, 'n1');
    const next = applyAiSaveResult(legacy, cur, plan, {
      configSaved: true,
      routeSaved: false,
    });
    const retry = buildAiSavePlan(next, cur, 'n1');
    expect(retry.config).toBeNull();
    expect(retry.aiReplyRoute).toBe('n1');
  });

  it('marks a first save configured', () => {
    const first: AiSavedState = {
      configured: false,
      values: emptyAiConfigForm(),
      route: null,
    };
    const cur = { values, route: null };
    const plan = buildAiSavePlan(first, cur, null);
    expect(
      applyAiSaveResult(first, cur, plan, {
        configSaved: true,
        routeSaved: false,
      }).configured
    ).toBe(true);
  });
});

describe('answer mode and sensitive-data reply', () => {
  it('defaults to generate / 0.8 / off', () => {
    const e = emptyAiConfigForm();
    expect(e.answerMode).toBe('generate');
    expect(e.approvedMinScore).toBe(0.8);
    expect(e.sensitiveReplyOn).toBe(false);
  });

  it('reads them from the response; blank text is off', () => {
    const on = aiConfigFormFromResponse({
      answer_mode: 'approved',
      approved_min_score: 0.7,
      sensitive_data_reply: 'warn',
    });
    expect(on).toMatchObject({
      answerMode: 'approved',
      approvedMinScore: 0.7,
      sensitiveReplyOn: true,
      sensitiveDataReply: 'warn',
    });
    expect(
      aiConfigFormFromResponse({ sensitive_data_reply: '  ' }).sensitiveReplyOn
    ).toBe(false);
    expect(aiConfigFormFromResponse({}).answerMode).toBe('generate');
  });

  it('sends null when the switch is off, even with text', () => {
    const body = aiConfigRequestBody({
      ...other,
      sensitiveReplyOn: false,
      sensitiveDataReply: 'x',
    });
    expect(body.sensitive_data_reply).toBeNull();
  });

  it('sends trimmed text when on, null when on but blank', () => {
    const on = { ...other, sensitiveReplyOn: true };
    expect(
      aiConfigRequestBody({ ...on, sensitiveDataReply: '  hi  ' })
        .sensitive_data_reply
    ).toBe('hi');
    expect(
      aiConfigRequestBody({ ...on, sensitiveDataReply: '  ' })
        .sensitive_data_reply
    ).toBeNull();
  });

  it('clamps and rounds the score', () => {
    const score = (n: number) =>
      aiConfigRequestBody({ ...other, approvedMinScore: n }).approved_min_score;
    expect(score(0.1)).toBe(0.5);
    expect(score(2)).toBe(0.99);
    expect(score(0.8049)).toBe(0.8);
    expect(score(NaN)).toBe(0.8);
    expect(aiConfigRequestBody(other).answer_mode).toBe('approved');
  });

  it('pre-fills the default text only when switched on and blank', () => {
    const base = emptyAiConfigForm();
    expect(toggleSensitiveReply(base, true, 'D')).toMatchObject({
      sensitiveReplyOn: true,
      sensitiveDataReply: 'D',
    });
    expect(
      toggleSensitiveReply({ ...base, sensitiveDataReply: 'mine' }, true, 'D')
        .sensitiveDataReply
    ).toBe('mine');
    expect(
      toggleSensitiveReply({ ...base, sensitiveDataReply: 'mine' }, false, 'D')
    ).toMatchObject({ sensitiveReplyOn: false, sensitiveDataReply: 'mine' });
  });
});
