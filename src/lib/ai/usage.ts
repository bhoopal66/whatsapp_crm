import type { SupabaseClient } from '@supabase/supabase-js';
import { AiError, type AiProvider, type AiUsage } from './types';

export interface LogAiUsageArgs {
  accountId: string;
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null;
  mode: 'auto_reply' | 'draft' | 'translate' | 'hr_agent' | 'kb_learn';
  provider: AiProvider;
  model: string;
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null;
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs
): Promise<void> {
  if (!args.usage) return;
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    });
    if (error) {
      console.error('[ai usage] log insert failed:', error);
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err);
  }
}

/**
 * Record the tokens of a billed call that ended in an `AiError` (cut
 * off, empty, unsafe): the provider charged for it all the same. A no-op
 * for any other error or when the provider reported no usage. NEVER
 * throws: `db` is a factory because building the service-role client
 * throws when its key is unset, and the caller is already on its way to
 * rethrowing the original error.
 */
export async function logFailedAiUsage(
  db: () => SupabaseClient,
  err: unknown,
  args: Omit<LogAiUsageArgs, 'usage'>
): Promise<void> {
  if (!(err instanceof AiError) || !err.usage) return;
  try {
    await logAiUsage(db(), { ...args, usage: err.usage });
  } catch (logErr) {
    console.error('[ai usage] failed-call log skipped:', logErr);
  }
}
