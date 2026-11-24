import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS, OPENAI_REASONING_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Whether an OpenAI model id names a reasoning model, whose hidden
 * reasoning counts against `max_completion_tokens`: the o-series and
 * GPT-5 and later minor versions, not their `-chat` variants. The id is
 * free text in the settings, so an unknown one is treated as plain.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return /^(o\d|gpt-5)(?![a-z0-9])/.test(id) && !id.includes('-chat');
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, maxTokens } = args;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens:
          (maxTokens ?? MAX_OUTPUT_TOKENS) +
          (isOpenAiReasoningModel(model) ? OPENAI_REASONING_TOKENS : 0),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
      usage,
    });
  }
  return {
    text,
    usage,
    truncated:
      choice?.finish_reason === 'length' ||
      choice?.finish_reason === 'content_filter',
  };
}
