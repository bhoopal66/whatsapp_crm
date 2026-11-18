import { describe, expect, it } from 'vitest';
import { collectTemplateVariableSlots } from './template-slots';
import { buildSendComponents } from './template-send-builder';
import type { MessageTemplate } from '@/types';

function template(body_text: string): MessageTemplate {
  return {
    body_text,
    header_type: null,
    header_content: null,
    buttons: [],
  } as unknown as MessageTemplate;
}

describe('collectTemplateVariableSlots', () => {
  it('asks for a named body variable', () => {
    expect(
      collectTemplateVariableSlots(template('Hi {{customer_name}}, welcome'))
        .bodyKeys
    ).toEqual(['customer_name']);
  });

  it('keeps positional variables in numeric order', () => {
    expect(
      collectTemplateVariableSlots(template('{{2}} then {{1}} then {{10}}'))
        .bodyKeys
    ).toEqual(['1', '2', '10']);
  });

  it('asks for nothing when the body has no variables', () => {
    expect(
      collectTemplateVariableSlots(template('Hello there')).bodyKeys
    ).toEqual([]);
  });

  it('asks for exactly as many values as the Meta send builder needs', () => {
    const t = template('Dear {{customer_name}}, your {{product}} is ready');
    const { bodyKeys } = collectTemplateVariableSlots(t);
    const body = bodyKeys.map((k) => `v-${k}`);
    expect(() => buildSendComponents(t, { body })).not.toThrow();
  });
});
