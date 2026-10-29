import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Why Jev pinned a chat: `conversations.insight_attention_reason`'s
 * CHECK (migration 153). Change one, change both.
 */
export type InsightAttentionReason =
  'urgent' | 'wants_person' | 'upset' | 'callback';

const REASON_BODY: Record<InsightAttentionReason, string> = {
  urgent: 'Urgent',
  wants_person: 'Wants a person',
  upset: 'Upset',
  callback: 'Asked for a call back',
};

export interface InsightAttentionBell {
  accountId: string;
  conversationId: string;
  /** auth user id: the chat's assigned agent, else its owner. */
  recipientUserId: string;
  reason: InsightAttentionReason;
  contactName: string | null;
}

/**
 * Ring the bell once for a chat Jev pinned for attention: one
 * `insight_attention` row (153's CHECK), which opens the chat from
 * `conversation_id` (`hrefFor`, `push_bell_url`) and is pushed by 109's
 * bell trigger. `db` is the service-role client. Best effort by
 * contract, like the other system bells: the pin is the record, so this
 * never throws; true when the row was written.
 */
export async function notifyInsightAttention(
  db: SupabaseClient,
  bell: InsightAttentionBell
): Promise<boolean> {
  try {
    const who = bell.contactName?.trim() || 'a customer';
    const { error } = await db.from('notifications').insert({
      account_id: bell.accountId,
      user_id: bell.recipientUserId,
      type: 'insight_attention',
      conversation_id: bell.conversationId,
      actor_user_id: null,
      title: `Needs attention: ${who}`,
      body: REASON_BODY[bell.reason] ?? null,
      meta: { reason: bell.reason },
    });
    if (error) {
      console.error(
        `[insights] conversation ${bell.conversationId}: attention bell not saved: ${error.message}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[insights] conversation ${bell.conversationId}: attention bell failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}
