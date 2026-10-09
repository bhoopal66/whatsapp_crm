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
