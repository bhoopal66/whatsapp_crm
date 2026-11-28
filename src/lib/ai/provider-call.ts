import { assertAiTransfer, promptSize } from '@/lib/privacy/ai-transfer';
import {
  AiError,
  type AiConfig,
  type ChatMessage,
  type ProviderResult,
} from './types';
import { aiRequestTimeoutMs, MAX_OUTPUT_TOKENS } from './defaults';
import { supabaseAdmin } from './admin-client';
import { estimateCallMicros, usageMicros } from './model-prices';
import {
  recordAiSpend,
  refundAiSpend,
  reserveAiSpend,
  type AiSpendDecision,
  type SpendRpcClient,
} from './spend-cap';

/** The AiError code of a call the daily AI spend cap refused: not
 *  transient, so no caller retries it. */
export const AI_SPEND_CAP_CODE = 'ai_spend_cap';
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

  // The owner's daily AI spend cap (334). A config without an account
  // (tests, a key check) is not checked, as with the transfer register.
  const accountId = config.accountId;
  if (!accountId) return dispatch(config.provider, providerArgs);
  let db: SpendRpcClient;
  let decision: AiSpendDecision;
  try {
    db = supabaseAdmin();
    decision = await reserveAiSpend(
      db,
      accountId,
      estimateCallMicros(
        providerArgs.model,
        promptSize(providerArgs.systemPrompt, providerArgs.messages),
        providerArgs.maxTokens ?? MAX_OUTPUT_TOKENS
      )
    );
  } catch {
    decision = { allowed: false, degraded: true, reservation: null };
  }
  if (!decision.allowed) {
    throw new AiError(
      decision.degraded
        ? 'The daily AI spend limit could not be checked, so the AI was not called.'
        : "Today's AI spend limit for this workspace has been reached.",
      { code: AI_SPEND_CAP_CODE, status: 429 }
    );
  }
  // No cap set: nothing was held, so nothing to settle.
  const reservation = decision.reservation;
  if (!reservation) return dispatch(config.provider, providerArgs);

  // Settle: the money actually spent is added with no cap (it is spent
  // either way), then the estimate is given back. A success without
  // usage keeps the estimate; a failure without usage was not billed.
  let spent = 0;
  try {
    const result = await dispatch(config.provider, providerArgs);
    spent = result.usage
      ? usageMicros(providerArgs.model, result.usage)
      : reservation.micros;
    return result;
  } catch (err) {
    if (err instanceof AiError && err.usage)
      spent = usageMicros(providerArgs.model, err.usage);
    throw err;
  } finally {
    await recordAiSpend(db!, accountId, spent);
    await refundAiSpend(db!, reservation);
  }
}

function dispatch(
  provider: AiConfig['provider'],
  providerArgs: ProviderArgs
): Promise<ProviderResult> {
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
