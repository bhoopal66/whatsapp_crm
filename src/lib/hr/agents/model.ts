/**
 * Recruiter agents (package 026a): the ModelPort over wacrm's own AI
 * providers (`lib/ai/provider-call.ts`: masked, transfer checked). The
 * account's key goes only into the provider call, never into a message. Candidate text
 * and history go only inside the delimited DATA block (`prompts.ts`).
 * Provider errors propagate unchanged, and a cut-off answer is an error
 * too (`assertComplete`): the orchestrator fails closed on any throw (handoff 'error', no draft). The model only suggests a label
 * or a draft; the guardrails stay in code.
 *
 * One retry, as in the package's adapter: a rate limit (429) or a
 * provider 5xx is tried exactly once more after a short, bounded delay;
 * anything else (a refused key, a 4xx, a timeout, a cut-off answer, a
 * refused transfer) is thrown at once. A second failure is thrown as is.
 */
import { callProvider } from '@/lib/ai/provider-call';
import { assertComplete } from '@/lib/ai/providers/shared';
import { echoesRedaction } from '@/lib/ai/redact-input';
import { AiError, type AiConfig, type AiUsage } from '@/lib/ai/types';
import type { ModelInput, ModelOutput, ModelPort } from './ports';
import { SYSTEM_PROMPTS, buildUserContent } from './prompts';
import { INTENTS, type Intent } from './types';

export const CLASSIFY_MAX_TOKENS = 20;
export const DRAFT_MAX_TOKENS = 400;
/** Delay before the one retry; any requested delay is clamped to the max. */
export const RETRY_DELAY_MS = 500;
export const RETRY_DELAY_MAX_MS = 2000;

export interface AiModelPortOptions {
  config: AiConfig;
  /** Provider timeout. Defaults to `aiRequestTimeoutMs()`. */
  timeoutMs?: number;
  /** Called after each successful provider call, with the model used. */
  onUsage?: (u: { model: string; usage: AiUsage | null }) => void;
  /** Delay before the one retry (default `RETRY_DELAY_MS`, clamped to 0..`RETRY_DELAY_MAX_MS`). */
  retryDelayMs?: number;
  /** Injectable wait, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A rate limit or a provider 5xx: worth exactly one more try. */
export function isTransientModelError(err: unknown): boolean {
  if (!(err instanceof AiError)) return false;
  if (err.code === 'rate_limited') return true;
  const s = err.upstreamStatus;
  return s !== null && s >= 500 && s <= 599;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const delay = Math.min(
    Math.max(opts.retryDelayMs ?? RETRY_DELAY_MS, 0),
    RETRY_DELAY_MAX_MS
  );
  const sleep = opts.sleep ?? wait;

  async function complete(input: ModelInput): Promise<ModelOutput> {
    const classify = input.task === 'classify';
    const model = classify ? (config.modelSmall ?? config.model) : config.model;
    const call = () =>
      callProvider({
        config,
        purpose: 'hr_agent',
        model,
        systemPrompt: SYSTEM_PROMPTS[input.agent],
        messages: [{ role: 'user', content: buildUserContent(input) }],
        timeoutMs: opts.timeoutMs,
        maxTokens: classify ? CLASSIFY_MAX_TOKENS : DRAFT_MAX_TOKENS,
      });
    let result;
    try {
      result = await call();
    } catch (err) {
      if (!isTransientModelError(err)) throw err;
      await sleep(delay);
      result = await call();
    }
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
