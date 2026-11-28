/**
 * The inbox Assistant's way into the second brain (`lib/brain/*`, 194):
 * `brain_search` (READ) and `brain_remember` (WRITE). Package 022b,
 * owner decision: the second brain only; CRM memory (`lib/memory/*`)
 * stays out of the Assistant.
 *
 * Both tools exist for a request only while all three hold, checked in
 * this order, and checked again by each handler (a card confirmed while
 * the brain was on must not run after it is switched off):
 *
 *   1. access   the caller has sales access and is agent or up (the
 *               /brain remember route's rule; the panel's own gate
 *               already needs agent);
 *   2. enabled  `case_account_settings.brain_enabled` (off by default;
 *               a failed read throws, never "on");
 *   3. transfer `assertAiTransfer` lets brain text go to the provider
 *               (privacy 224: a new AI call path calls it).
 *
 * The port carries the account and the actor from the session; the
 * model's arguments never name either.
 */
import { AiError } from '@/lib/ai/types';
import type { BrainHit } from '@/lib/brain/ports';
import { TRANSFER_REFUSED_CODE } from '@/lib/privacy/ai-transfer';

export type ChatAssistBrainPurpose = 'brain_search' | 'brain_remember';

export interface ChatAssistBrainPort {
  /** Sales access and agent or up: computed from the session. */
  readonly access: boolean;
  /** `brain_enabled` for the active account; a failed read throws. */
  enabled(): Promise<boolean>;
  /** `assertAiTransfer` for the workspace's provider; throws when refused. */
  transfer(purpose: ChatAssistBrainPurpose, bytes: number): Promise<void>;
  /** The /brain search route's bucket (`brain.search`, 60 a minute). */
  searchAllowed(): Promise<boolean>;
  /** `searchBrain` as the caller: their visibility only. */
  search(query: string): Promise<BrainHit[]>;
  /**
   * The /brain "remember this" path: `ingestRemember` (redacted, refused
   * when the redactor refuses) then pages marked dirty. `ok: false` is a
   * redaction refusal.
   */
  remember(
    text: string,
    contactId: string | null
  ): Promise<{ ok: true; itemIds: string[] } | { ok: false }>;
}

export type ChatAssistBrainRefusal = 'no_brain' | 'access' | 'off' | 'transfer';

/**
 * Whether the brain tools may run now, for `purpose`. A transfer
 * refusal is an answer (`transfer`); any other failure throws, so a
 * caller that cannot tell treats the tools as absent.
 */
export async function chatAssistBrainCheck(
  port: ChatAssistBrainPort | undefined,
  purpose: ChatAssistBrainPurpose,
  bytes = 0
): Promise<{ ok: true } | { ok: false; reason: ChatAssistBrainRefusal }> {
  if (!port) return { ok: false, reason: 'no_brain' };
  if (!port.access) return { ok: false, reason: 'access' };
  if (!(await port.enabled())) return { ok: false, reason: 'off' };
  try {
    await port.transfer(purpose, bytes);
  } catch (err) {
    if (err instanceof AiError && err.code === TRANSFER_REFUSED_CODE)
      return { ok: false, reason: 'transfer' };
    throw err;
  }
  return { ok: true };
}

/**
 * The same check for deciding what the model is offered: any failure
 * (a switch read that fails included) hides the tools. Fail closed.
 */
export async function chatAssistBrainAvailable(
  port: ChatAssistBrainPort | undefined,
  purpose: ChatAssistBrainPurpose
): Promise<boolean> {
  try {
    return (await chatAssistBrainCheck(port, purpose)).ok;
  } catch {
    return false;
  }
}
