/** 024a cv_screening specialist: drafts via the ModelPort; a returned intent other than the input's is a re-route. */
import type { ModelPort } from '../ports';
import type { SpecialistInput, SpecialistResult } from './common';

export async function cvScreening(
  input: SpecialistInput,
  model: ModelPort
): Promise<SpecialistResult> {
  const out = await model.complete({
    task: 'draft',
    agent: 'cv_screening',
    lang: input.lang,
    stage: input.stage,
    inboundText: input.inboundText,
    history: input.history,
    intent: input.intent,
    slots: [],
  });
  if (out.intent && out.intent !== input.intent)
    return { text: '', reroute: out.intent };
  return { text: out.text ?? '' };
}
