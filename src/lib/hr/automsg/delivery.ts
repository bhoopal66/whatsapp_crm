/**
 * HR automated messages: delivery receipts onto the outbox row (package
 * 029b, migration 212). `handleStatusUpdate` calls this after its own
 * mirrors; SQL matches the receipt to the row by provider message id
 * inside the account, keeps the state forward-only, and makes a sent row
 * terminal on a 'failed' receipt.
 *
 * Gated so other traffic costs no round trip: only an authenticated
 * account, only a state SQL takes, and only when the receipt resolved to
 * a bot message (HR sends are recorded as sender_type 'bot').
 *
 * Never throws; logs one line on error, without the token or the text, and
 * answers false so that the receipt is retried.
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isMissingFunction } from '@/lib/team-activity/db-errors';
import type { NormalizedStatus } from '@/lib/whatsapp/inbound';

export type HrDeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

const STATES: readonly string[] = ['sent', 'delivered', 'read', 'failed'];

export function isHrDeliveryState(s: string): s is HrDeliveryState {
  return STATES.includes(s);
}

export async function recordHrDelivery(args: {
  accountId: string | undefined;
  status: NormalizedStatus;
  /** The receipt time, ISO. */
  at: string;
  /** The `messages` rows the receipt resolved to. */
  rows: readonly { sender_type?: string | null }[];
}): Promise<boolean> {
  const { accountId, status, at, rows } = args;
  if (!accountId) return true;
  if (!isHrDeliveryState(status.status)) return true;
  if (!rows.some((r) => r.sender_type === 'bot')) return true;
  try {
    const { error } = await supabaseAdmin().rpc('hr_automsg_delivery_record', {
      p_account_id: accountId,
      p_provider_message_id: status.messageId,
      p_state: status.status,
      p_at: at,
      p_reason: status.error?.code != null ? String(status.error.code) : null,
    });
    if (error) {
      console.error('[hr-automsg] delivery record failed:', error.message);
      return isMissingFunction(error);
    }
    return true;
  } catch (err) {
    console.error(
      '[hr-automsg] delivery record failed:',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}
