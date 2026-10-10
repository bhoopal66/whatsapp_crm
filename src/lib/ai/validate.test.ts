import { describe, it, expect } from 'vitest';
import { MAX_MODEL_ID_LENGTH, parseAiAgentV2Settings } from './validate';

describe('parseAiAgentV2Settings', () => {
  it('leaves absent fields out, so a partial save changes nothing', () => {
    expect(parseAiAgentV2Settings({ model: 'gpt-x' })).toEqual({
      ok: true,
      values: {},
    });
  });

  it('accepts every field', () => {
    expect(
      parseAiAgentV2Settings({
        model_small: '  gpt-5.4-nano ',
        model_large: 'gpt-5.5',
        model_routing: false,
        pause_on_agent_reply: true,
        auto_resume_minutes: 60,
        guardrail_retry: false,
        reply_on_all_numbers: true,
      })
    ).toEqual({
      ok: true,
      values: {
        model_small: 'gpt-5.4-nano',
        model_large: 'gpt-5.5',
        model_routing: false,
        pause_on_agent_reply: true,
        auto_resume_minutes: 60,
        guardrail_retry: false,
        reply_on_all_numbers: true,
      },
    });
  });

  it('reads a blank or null tier model as null (use `model`)', () => {
    expect(
      parseAiAgentV2Settings({ model_small: '   ', model_large: null })
    ).toEqual({ ok: true, values: { model_small: null, model_large: null } });
  });

  it('rejects a tier model that is too long or not a string', () => {
    expect(
      parseAiAgentV2Settings({
        model_large: 'x'.repeat(MAX_MODEL_ID_LENGTH + 1),
      }).ok
    ).toBe(false);
    expect(parseAiAgentV2Settings({ model_small: 3 }).ok).toBe(false);
  });

  it('rejects a non-boolean switch', () => {
    expect(parseAiAgentV2Settings({ model_routing: 'yes' }).ok).toBe(false);
    expect(parseAiAgentV2Settings({ pause_on_agent_reply: 1 }).ok).toBe(false);
    expect(parseAiAgentV2Settings({ guardrail_retry: null }).ok).toBe(false);
    expect(parseAiAgentV2Settings({ reply_on_all_numbers: 'on' }).ok).toBe(
      false
    );
  });

  it('bounds auto_resume_minutes to 5..10080 whole minutes, or null', () => {
    for (const ok of [null, 5, 10080]) {
      expect(parseAiAgentV2Settings({ auto_resume_minutes: ok })).toEqual({
        ok: true,
        values: { auto_resume_minutes: ok },
      });
    }
    for (const bad of [4, 10081, 30.5, '60', -1]) {
      expect(parseAiAgentV2Settings({ auto_resume_minutes: bad }).ok).toBe(
        false
      );
    }
  });
});

describe('parseAiAgentV2Settings approved answers (migration 081)', () => {
  it('accepts the three fields, trimming the reply', () => {
    expect(
      parseAiAgentV2Settings({
        answer_mode: 'approved',
        approved_min_score: 0.5,
        sensitive_data_reply: '  Please do not share that.  ',
      })
    ).toEqual({
      ok: true,
      values: {
        answer_mode: 'approved',
        approved_min_score: 0.5,
        sensitive_data_reply: 'Please do not share that.',
      },
    });
  });

  it('reads a blank or null sensitive-data reply as off', () => {
    for (const raw of ['', '   ', null]) {
      expect(parseAiAgentV2Settings({ sensitive_data_reply: raw })).toEqual({
        ok: true,
        values: { sensitive_data_reply: null },
      });
    }
  });

  it('rejects a bad mode, an out-of-range score and an over-long reply', () => {
    expect(parseAiAgentV2Settings({ answer_mode: 'other' }).ok).toBe(false);
    expect(parseAiAgentV2Settings({ answer_mode: null }).ok).toBe(false);
    for (const bad of [0.49, 1, 0.995, '0.8', null, NaN]) {
      expect(parseAiAgentV2Settings({ approved_min_score: bad }).ok).toBe(
        false
      );
    }
    expect(parseAiAgentV2Settings({ approved_min_score: 0.99 }).ok).toBe(true);
    expect(parseAiAgentV2Settings({ sensitive_data_reply: 5 }).ok).toBe(false);
    expect(
      parseAiAgentV2Settings({ sensitive_data_reply: 'x'.repeat(1001) }).ok
    ).toBe(false);
    expect(
      parseAiAgentV2Settings({ sensitive_data_reply: 'x'.repeat(1000) }).ok
    ).toBe(true);
  });
});
