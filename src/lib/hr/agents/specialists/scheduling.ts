/** 024a scheduling specialist: drafts via the ModelPort; a returned intent other than the input's is a re-route. */
import type { ModelPort } from '../ports';
import type { SpecialistInput, SpecialistResult } from './common';

export async function scheduling(
  input: SpecialistInput,
  model: ModelPort
): Promise<SpecialistResult> {
  const out = await model.complete({
    task: 'draft',
    agent: 'scheduling',
    lang: input.lang,
    stage: input.stage,
    inboundText: input.inboundText,
    history: input.history,
    intent: input.intent,
    slots: input.slots,
  });
  if (out.intent && out.intent !== input.intent)
    return { text: '', reroute: out.intent };
  return { text: out.text ?? '' };
}
