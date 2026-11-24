/**
 * Recruiter agents (package 026a): the ModelPort over wacrm's own AI
 * providers (`lib/ai/provider-call.ts`: masked, transfer checked). The
 * account's key goes only into the provider call, never into a message. Candidate text
 * and history go only inside the delimited DATA block (`prompts.ts`).
 * Provider errors propagate unchanged, and a cut-off answer is an error
 * too (`assertComplete`): the orchestrator fails closed on any throw (handoff 'error', no draft). The model only suggests a label
 * or a draft; the guardrails stay in code.
 */
import { callProvider } from '@/lib/ai/provider-call';
import { assertComplete } from '@/lib/ai/providers/shared';
import { echoesRedaction } from '@/lib/ai/redact-input';
import type { AiConfig, AiUsage } from '@/lib/ai/types';
import type { ModelInput, ModelOutput, ModelPort } from './ports';
import { SYSTEM_PROMPTS, buildUserContent } from './prompts';
import { INTENTS, type Intent } from './types';

export const CLASSIFY_MAX_TOKENS = 20;
export const DRAFT_MAX_TOKENS = 400;

export interface AiModelPortOptions {
  config: AiConfig;
  /** Provider timeout. Defaults to `aiRequestTimeoutMs()`. */
  timeoutMs?: number;
  /** Called after each successful provider call, with the model used. */
  onUsage?: (u: { model: string; usage: AiUsage | null }) => void;
}

/** Parses a classify answer to one known intent; anything else is undefined (the orchestrator then uses 'other'). */
export function parseIntent(text: string): Intent | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
  return (INTENTS as readonly string[]).includes(t) ? (t as Intent) : undefined;
}

export function createAiModelPort(opts: AiModelPortOptions): ModelPort {
  const { config, onUsage } = opts;

  async function complete(input: ModelInput): Promise<ModelOutput> {
    const classify = input.task === 'classify';
    const model = classify ? (config.modelSmall ?? config.model) : config.model;
    const result = await callProvider({
      config,
      purpose: 'hr_agent',
      model,
      systemPrompt: SYSTEM_PROMPTS[input.agent],
      messages: [{ role: 'user', content: buildUserContent(input) }],
      timeoutMs: opts.timeoutMs,
      maxTokens: classify ? CLASSIFY_MAX_TOKENS : DRAFT_MAX_TOKENS,
    });
    onUsage?.({ model, usage: result.usage });
    assertComplete(result);

    if (classify) {
      const intent = parseIntent(result.text);
      return intent ? { text: '', intent } : { text: '' };
    }
    const text = result.text.trim();
    // A repeated mask is no draft: the orchestrator hands an empty one off.
    return { text: echoesRedaction(text) ? '' : text };
  }

  return { complete };
}
