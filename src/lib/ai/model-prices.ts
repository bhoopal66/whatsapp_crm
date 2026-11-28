import type { AiUsage } from './types';

/**
 * What a chat call costs, in integer USD micros, for the daily AI spend
 * cap (`spend-cap.ts`). Prices are list prices in USD per million
 * tokens, which is the same number as micros per token.
 *
 * Only Anthropic's first-party list prices are here (as published
 * 2026-11-03). A model not in the table (every OpenAI model, an alias,
 * a new release) has no known price: a call to it is counted at
 * `UNPRICED_CALL_MICROS`, so the cap still counts it, just not by size.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-mythos-5-2': { input: 8, output: 40 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** A call to a model with no known price: $0.001. */
export const UNPRICED_CALL_MICROS = 1_000;

/** Characters per token for the input estimate; low on purpose (Arabic
 *  and masked text run well under English's ~4). */
const CHARS_PER_TOKEN = 3;

/** The model's price, a dated snapshot id (`claude-haiku-4-5-20251001`)
 *  matching its family; null when unknown. */
export function modelPrice(
  model: string
): { input: number; output: number } | null {
  return PRICES[model.replace(/-\d{8}$/, '')] ?? null;
}

/** What to reserve before a call: the prompt's estimated input plus the
 *  whole output cap. */
export function estimateCallMicros(
  model: string,
  promptChars: number,
  maxOutputTokens: number
): number {
  const price = modelPrice(model);
  if (!price) return UNPRICED_CALL_MICROS;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  return Math.ceil(inputTokens * price.input + maxOutputTokens * price.output);
}

/** What a finished call cost, from the provider's own usage. */
export function usageMicros(model: string, usage: AiUsage): number {
  const price = modelPrice(model);
  if (!price) return UNPRICED_CALL_MICROS;
  return Math.ceil(
    usage.promptTokens * price.input + usage.completionTokens * price.output
  );
}
