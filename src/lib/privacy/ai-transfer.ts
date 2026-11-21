/**
 * The AI transfer register (migration 224), checked just before customer
 * text leaves for an AI provider: ai_transfer_check logs the call (sizes
 * and labels, no text) and answers whether it may go. It refuses only
 * while the workspace requires a basis and none complete is on record.
 *
 * Fail open: when the check itself cannot run (the database is down, or
 * 224 is not applied yet) the call goes and the failure is logged. A
 * refused call surfaces as AiError `transfer_basis_required`, which every
 * AI path already handles (the bot hands off, a route answers an error).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';

export type AiDestination = 'openai' | 'anthropic' | 'typesafe';

export interface TransferInput {
  accountId: string;
  destination: AiDestination;
  /** What the call is for, `[a-z_]{1,40}` (reply, draft, translate, …). */
  purpose: string;
  model: string | null;
  /** Size of what is sent, in characters. */
  bytes: number;
}

export type TransferCheck = (input: TransferInput) => Promise<boolean>;

export function makeTransferCheck(db: () => SupabaseClient): TransferCheck {
  return async (input) => {
    try {
      const { data, error } = await db().rpc('ai_transfer_check', {
        p_account: input.accountId,
        p_destination: input.destination,
        p_purpose: input.purpose,
        p_model: input.model,
        p_bytes: Math.max(0, Math.round(input.bytes)),
      });
      if (error) {
        console.error(
          `[privacy] ai_transfer_check failed (${error.code ?? '-'}); call allowed`
        );
        return true;
      }
      return data !== false;
    } catch {
      console.error('[privacy] ai_transfer_check unreachable; call allowed');
      return true;
    }
  };
}

export const aiTransferAllowed: TransferCheck =
  makeTransferCheck(supabaseAdmin);

export const TRANSFER_REFUSED_CODE = 'transfer_basis_required';

/**
 * Throws when the workspace requires a basis and has none. A config
 * without an account (tests, a key check, the playground's own text) is
 * not checked.
 */
export async function assertAiTransfer(
  config: { accountId?: string; provider: string },
  purpose: string,
  model: string | null,
  bytes: number,
  check: TransferCheck = aiTransferAllowed
): Promise<void> {
  if (!config.accountId) return;
  if (config.provider !== 'openai' && config.provider !== 'anthropic') return;
  const ok = await check({
    accountId: config.accountId,
    destination: config.provider,
    purpose,
    model,
    bytes,
  });
  if (!ok)
    throw new AiError(
      'This workspace requires a recorded legal basis before sending customer text to an AI provider (Settings → Privacy).',
      { code: TRANSFER_REFUSED_CODE, status: 451 }
    );
}

/** Characters of a prompt (system text plus every message). */
export function promptSize(
  systemPrompt: string,
  messages: { content: unknown }[]
): number {
  return (
    systemPrompt.length +
    messages.reduce(
      (n, m) =>
        n +
        (typeof m.content === 'string'
          ? m.content.length
          : JSON.stringify(m.content).length),
      0
    )
  );
}
