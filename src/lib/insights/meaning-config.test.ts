import { describe, expect, it } from 'vitest';
import { validateIntentTriggerConfig } from './meaning-config';
import { validateTriggerForActivation } from '@/lib/automations/validate';
import { validateFlowForActivation } from '@/lib/flows/validate';

const fields = (raw: unknown) =>
  validateIntentTriggerConfig(raw).map((i) => i.field);

describe('validateIntentTriggerConfig', () => {
  it('accepts a full config', () => {
    expect(
      fields({
        description: 'The customer wants a business loan.',
        examples: ['I need financing', 'قرض'],
        sensitivity: 'strict',
      })
    ).toEqual([]);
  });

  it('needs a 10–300 character description', () => {
    expect(fields({})).toEqual(['description']);
    expect(fields({ description: 'too short' })).toEqual(['description']);
    expect(fields({ description: 'x'.repeat(301) })).toEqual(['description']);
    expect(fields({ description: 'x'.repeat(300) })).toEqual([]);
  });

  it('allows at most 5 examples of 1–120 characters', () => {
    const d = 'The customer wants a loan.';
    expect(fields({ description: d, examples: 'nope' })).toEqual(['examples']);
    expect(
      fields({ description: d, examples: ['a', 'b', 'c', 'd', 'e', 'f'] })
    ).toEqual(['examples']);
    expect(
      fields({ description: d, examples: ['ok', ' ', 'y'.repeat(121), 3] })
    ).toEqual(['examples.1', 'examples.2', 'examples.3']);
  });

  it('allows only the three sensitivities', () => {
    const d = 'The customer wants a loan.';
    expect(fields({ description: d, sensitivity: 'medium' })).toEqual([
      'sensitivity',
    ]);
  });
});

describe('intent triggers in the activation validators', () => {
  it('automations: intent_match is a known trigger, validated', () => {
    expect(
      validateTriggerForActivation('intent_match', {
        description: 'The customer wants a loan.',
      })
    ).toEqual([]);
    expect(
      validateTriggerForActivation('intent_match', { description: 'short' })
    ).toEqual([expect.objectContaining({ path: 'trigger.description' })]);
  });

  it('flows: an intent trigger with a bad config is an error', () => {
    const flow = (trigger_config: Record<string, unknown>) =>
      validateFlowForActivation(
        { name: 'F', trigger_type: 'intent', trigger_config } as never,
        []
      ).filter((i) => i.scope === 'trigger');
    expect(flow({ description: 'The customer wants a loan.' })).toEqual([]);
    expect(flow({ description: 'short', sensitivity: 'x' })).toEqual([
      expect.objectContaining({
        severity: 'error',
        field: 'trigger_config.description',
      }),
      expect.objectContaining({
        severity: 'error',
        field: 'trigger_config.sensitivity',
      }),
    ]);
  });
});
