// ============================================================
// "Pinned until someone acts" (docs/jev-insights.md, "Customer insights").
//
// After a customer message is judged, the server may pin the chat for a
// person's attention (conversations.insight_attention_at / _reason,
// migration 153) and ring the bell once. A pin is cleared only by a
// person: their reply, closing the chat, or "Handled" (153's triggers
// and acknowledge_insight_attention()). So this writer must never pin a
// chat someone already dealt with: not a closed chat, and not when a
// person replied at or after the judged message (a judgment that lands
// after the answer). 153's insight_pin_attention() decides all of that
// under the chat's row lock. Service role only. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyInsightAttention } from '@/lib/notifications/insight-attention';
import type { AttentionReason } from './bands';

export interface AttentionArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** created_at of the judged inbound message: the pin's time. */
  messageAt: string;
  /** attentionReason() for this message's figures. */
  reason: AttentionReason;
  /** The workspace's attentionNotify switch. */
  notify: boolean;
}

export type AttentionResult =
  /** Newly pinned (the bell rang when `notify` and a recipient exists). */
  | 'pinned'
  /** Already pinned for a lower-precedence reason: reason raised. */
  | 'raised'
  /** Already pinned for this reason or a higher one. */
  | 'superseded'
  /** Closed or gone: nothing to pin. */
  | 'closed'
  /** A person replied at or after the message: already dealt with. */
  | 'answered'
  | 'error';

export interface AttentionOutcome {
  result: AttentionResult;
  /** The bell was written. */
  notified: boolean;
}

interface ConvRow {
  assigned_agent_id: string | null;
  user_id: string | null;
}

const RPC_RESULTS: readonly AttentionResult[] = [
  'pinned',
  'raised',
  'superseded',
  'closed',
  'answered',
];

/**
 * Pin (or raise) the chat's attention for this judgment. Never throws.
 *
 * One call to 153's insight_pin_attention(), which locks the chat, looks
 * for a person's reply in a snapshot taken after the lock, and pins (or
 * raises the reason) in the same transaction, noting
 * insight_attention_set. A read here followed by a write would let a
 * reply land in between and leave an answered chat pinned.
 */
export async function applyInsightAttention(
  db: SupabaseClient,
  args: AttentionArgs
): Promise<AttentionOutcome> {
  const { accountId, conversationId, messageAt, reason } = args;
  try {
    const { data, error } = await db.rpc('insight_pin_attention', {
      p_account: accountId,
      p_conv: conversationId,
      p_message_at: messageAt,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    const result = RPC_RESULTS.find((r) => r === data);
    if (!result) throw new Error(`unexpected pin result: ${String(data)}`);
    if (result !== 'pinned') return done(result);
    const notified = args.notify ? await ring(db, args) : false;
    return { result, notified };
  } catch (err) {
    console.error(
      `[insights] conversation ${conversationId}: attention not applied:`,
      err instanceof Error ? err.message : String(err)
    );
    return done('error');
  }
}

const done = (result: AttentionResult): AttentionOutcome => ({
  result,
  notified: false,
});

/** The bell for a new pin. Best effort: the pin is the record, so a
 *  failure here is logged and the pin stands. */
async function ring(db: SupabaseClient, args: AttentionArgs): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('conversations')
      .select('assigned_agent_id, user_id')
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return false;
    const recipient = await bellRecipient(db, args.accountId, data as ConvRow);
    if (!recipient) return false;
    return await notifyInsightAttention(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      recipientUserId: recipient,
      reason: args.reason,
      contactName: await contactName(db, args.accountId, args.contactId),
    });
  } catch (err) {
    console.error(
      `[insights] conversation ${args.conversationId}: attention bell skipped:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Who the bell goes to: the assigned agent, else the chat's owner. Both
 * columns hold auth user ids (the send route stamps `assigned_agent_id`
 * with the caller's auth id, and can_view_conversation compares both to
 * auth.uid()). Each counts only while that person is live staff in this
 * workspace; null when neither is.
 */
async function bellRecipient(
  db: SupabaseClient,
  accountId: string,
  conv: ConvRow
): Promise<string | null> {
  const ids = [conv.assigned_agent_id, conv.user_id].filter(
    (x): x is string => typeof x === 'string' && x.length > 0
  );
  if (ids.length === 0) return null;
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('user_id', ids)
    .is('deactivated_at', null)
    .neq('account_role', 'bank_guest');
  if (error) throw new Error(error.message);
  const live = new Set(
    ((data ?? []) as { user_id: string }[]).map((p) => p.user_id)
  );
  return ids.find((id) => live.has(id)) ?? null;
}

/** The contact's name for the bell's title (internal only). */
async function contactName(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<string | null> {
  const { data } = await db
    .from('contacts')
    .select('name')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as { name: string | null } | null)?.name ?? null;
}
