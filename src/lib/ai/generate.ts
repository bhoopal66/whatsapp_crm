import type { AiConfig, AiUsage, ChatMessage, GenerateResult } from './types';
import { HANDOFF_SENTINEL } from './defaults';
import { callProvider } from './provider-call';
import { assertComplete } from './providers/shared';

export interface GenerateArgs {
  config: AiConfig;
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
  /** The model to ask, on the configured provider and key. Defaults to
   *  `config.model`; the auto-reply router passes a tier's model. */
  model?: string;
  /** Provider timeout for this call. Defaults to `aiRequestTimeoutMs()`;
   *  the auto-reply dispatcher passes less when its budget is running
   *  out. */
  timeoutMs?: number;
  /** What the call is for, in the AI transfer register (migration 224). */
  purpose?: string;
}

/**
 * Generate the next reply from the account's configured provider.
 * `callProvider` masks, checks the transfer and picks the adapter; the
 * handoff sentinel is then parsed out of the raw text. Throws `AiError` on any provider/network failure, and
 * `truncated` when the provider cut the answer off.
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { config } = args;
  const result = await callProvider({
    config,
    purpose: args.purpose ?? 'reply',
    model: args.model ?? config.model,
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    timeoutMs: args.timeoutMs,
  });
  assertComplete(result);
  return parseGeneration(result.text, result.usage);
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  const text = raw.split(HANDOFF_SENTINEL).join('').trim();
  return { text, handoff, usage };
}
