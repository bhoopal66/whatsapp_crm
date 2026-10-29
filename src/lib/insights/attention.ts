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
// after the answer). Service role only. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyInsightAttention } from '@/lib/notifications/insight-attention';
import { ATTENTION_REASONS, type AttentionReason } from './bands';

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
  | 'kept'
  /** Closed or gone: nothing to pin. */
  | 'closed'
  /** A person replied at or after the message: already dealt with. */
  | 'answered'
  /** The compare-and-set found the chat changed meanwhile. */
  | 'superseded'
  | 'error';

export interface AttentionOutcome {
  result: AttentionResult;
  /** The bell was written. */
  notified: boolean;
}

interface ConvRow {
  status: string | null;
  insight_attention_at: string | null;
  insight_attention_reason: string | null;
  assigned_agent_id: string | null;
  user_id: string | null;
}

/** Lower is more important; an unknown stored reason ranks last. */
const rank = (r: string | null | undefined): number => {
  const i = (ATTENTION_REASONS as readonly string[]).indexOf(r ?? '');
  return i < 0 ? ATTENTION_REASONS.length : i;
};

/** Pin (or raise) the chat's attention for this judgment. Never throws. */
export async function applyInsightAttention(
  db: SupabaseClient,
  args: AttentionArgs
): Promise<AttentionOutcome> {
  const { accountId, conversationId, messageAt, reason } = args;
  try {
    const { data, error } = await db
      .from('conversations')
      .select(
        'status, insight_attention_at, insight_attention_reason, assigned_agent_id, user_id'
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const conv = data as ConvRow | null;
    if (!conv || conv.status === 'closed') return done('closed');

    if (conv.insight_attention_at != null) {
      const from = conv.insight_attention_reason;
      if (rank(reason) >= rank(from)) return done('kept');
      // Raise the reason, keep the time: the chat has waited since then.
      const { data: rows, error: upErr } = await db
        .from('conversations')
        .update({ insight_attention_reason: reason })
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .eq('insight_attention_at', conv.insight_attention_at)
        .eq('insight_attention_reason', from)
        .select('id');
      if (upErr) throw new Error(upErr.message);
      if (!hit(rows)) return done('superseded');
      await noteSet(db, args, { reason, raisedFrom: from });
      return done('raised');
    }

    if (await personRepliedSince(db, conversationId, messageAt))
      return done('answered');

    const { data: rows, error: upErr } = await db
      .from('conversations')
      .update({
        insight_attention_at: messageAt,
        insight_attention_reason: reason,
      })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      // Someone may have closed the chat, or another judgment pinned it,
      // since the read: the pin lands only on an open, unpinned chat.
      .is('insight_attention_at', null)
      .neq('status', 'closed')
      .select('id');
    if (upErr) throw new Error(upErr.message);
    if (!hit(rows)) return done('superseded');

    await noteSet(db, args, { reason });
    const notified = args.notify ? await ring(db, args, conv) : false;
    return { result: 'pinned', notified };
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

const hit = (rows: unknown) => Array.isArray(rows) && rows.length > 0;

/** The bell for a new pin. Best effort: the pin is the record, so a
 *  failure here is logged and the pin stands. */
async function ring(
  db: SupabaseClient,
  args: AttentionArgs,
  conv: ConvRow
): Promise<boolean> {
  try {
    const recipient = await bellRecipient(db, args.accountId, conv);
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

/** A person's reply (077/078's test, as 153's clearing trigger uses) at
 *  or after the judged message. */
async function personRepliedSince(
  db: SupabaseClient,
  conversationId: string,
  messageAt: string
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
    .not('sender_id', 'is', null)
    .gte('created_at', messageAt)
    .limit(1);
  if (error) throw new Error(error.message);
  return hit(data);
}

/** The insight_attention_set note. The pin is the record: a failed note
 *  is logged and changes nothing. */
async function noteSet(
  db: SupabaseClient,
  args: AttentionArgs,
  details: { reason: AttentionReason; raisedFrom?: string | null }
): Promise<void> {
  const { error } = await db.from('conversation_events').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    kind: 'insight_attention_set',
    actor_user_id: null,
    details,
  });
  if (error)
    console.error(
      `[insights] conversation ${args.conversationId}: attention note not saved: ${error.message}`
    );
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
