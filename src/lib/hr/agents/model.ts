/**
 * Recruiter agents (package 026a): the ModelPort over wacrm's own AI
 * providers, the way `lib/ai/translate.ts` calls them. The account's key
 * goes only into the provider call, never into a message. Candidate text
 * and history go only inside the delimited DATA block (`prompts.ts`).
 * Provider errors propagate unchanged: the orchestrator fails closed on
 * any throw (handoff 'error', no draft). The model only suggests a label
 * or a draft; the guardrails stay in code.
 */
import { assertAiTransfer, promptSize } from '@/lib/privacy/ai-transfer';
import { aiRequestTimeoutMs } from '@/lib/ai/defaults';
import { generateAnthropic } from '@/lib/ai/providers/anthropic';
import { generateOpenAi } from '@/lib/ai/providers/openai';
import type { ProviderArgs } from '@/lib/ai/providers/shared';
import { AiError, type AiConfig, type AiUsage } from '@/lib/ai/types';
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
    const providerArgs: ProviderArgs = {
      apiKey: config.apiKey,
      model,
      systemPrompt: SYSTEM_PROMPTS[input.agent],
      messages: [{ role: 'user', content: buildUserContent(input) }],
      timeoutMs: opts.timeoutMs ?? aiRequestTimeoutMs(),
      maxTokens: classify ? CLASSIFY_MAX_TOKENS : DRAFT_MAX_TOKENS,
    };

    await assertAiTransfer(
      config,
      'hr_agent',
      model,
      promptSize(providerArgs.systemPrompt, providerArgs.messages)
    );
    let result: { text: string; usage: AiUsage | null };
    const provider = config.provider;
    switch (provider) {
      case 'openai':
        result = await generateOpenAi(providerArgs);
        break;
      case 'anthropic':
        result = await generateAnthropic(providerArgs);
        break;
      default: {
        const never: never = provider;
        throw new AiError(`Unsupported AI provider: ${String(never)}`, {
          code: 'unsupported_provider',
          status: 400,
        });
      }
    }
    onUsage?.({ model, usage: result.usage });

    if (classify) {
      const intent = parseIntent(result.text);
      return intent ? { text: '', intent } : { text: '' };
    }
    return { text: result.text.trim() };
  }

  return { complete };
}
