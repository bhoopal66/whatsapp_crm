import { assertAiTransfer, promptSize } from '@/lib/privacy/ai-transfer';
import {
  AiError,
  type AiConfig,
  type ChatMessage,
  type ProviderResult,
} from './types';
import { aiRequestTimeoutMs } from './defaults';
import { generateAnthropic } from './providers/anthropic';
import { generateOpenAi } from './providers/openai';
import type { ProviderArgs } from './providers/shared';
import { redactMessages } from './redact-input';

export interface ProviderCallArgs {
  config: AiConfig;
  /** What the call is for, in the AI transfer register (migration 224). */
  purpose: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  /** Provider timeout. Defaults to `aiRequestTimeoutMs()`. */
  timeoutMs?: number;
  /** Output token cap. Defaults to the adapters' own. */
  maxTokens?: number;
}

/**
 * The one way to a chat provider: every turn is masked
 * (`redactMessages`) and the transfer register asked before any text
 * leaves. No other module imports the adapters
 * (`provider-call.test.ts` scans for it), so a new AI path cannot
 * forget either. The raw result comes back: the caller runs
 * `assertComplete` itself, since some record the spend first.
 */
export async function callProvider(
  args: ProviderCallArgs
): Promise<ProviderResult> {
  const { config, purpose } = args;
  const providerArgs: ProviderArgs = {
    apiKey: config.apiKey,
    model: args.model,
    systemPrompt: args.systemPrompt,
    messages: redactMessages(args.messages),
    timeoutMs: args.timeoutMs ?? aiRequestTimeoutMs(),
    maxTokens: args.maxTokens,
  };
  await assertAiTransfer(
    config,
    purpose,
    providerArgs.model,
    promptSize(providerArgs.systemPrompt, providerArgs.messages)
  );

  const provider = config.provider;
  switch (provider) {
    case 'openai':
      return generateOpenAi(providerArgs);
    case 'anthropic':
      return generateAnthropic(providerArgs);
    default: {
      const never: never = provider;
      throw new AiError(`Unsupported AI provider: ${String(never)}`, {
        code: 'unsupported_provider',
        status: 400,
      });
    }
  }
}
