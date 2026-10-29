// ============================================================
// Campaign reply sorting (docs/jev-insights.md, "Campaign reply
// sorting"; migration 148).
//
// A customer's first reply to a broadcast is judged by Jev into one of
// seven classes (questions/reply-class.ts) and the class is stored on
// the broadcast_recipients row, service role only (148's guard). The
// inbound pipeline calls this right after flagging the reply, with a
// short deadline, so a follow-up flow can branch on the class; the
// backfill route calls it for replies that came in before the feature
// was switched on.
//
// The judgment sees what the customer was replying to: the template
// body with every placeholder replaced by a neutral token. Never the
// recipient's own values (migration 038's template_params are usually
// their name, which redaction does not remove). With no local template
// row there is nothing to judge against, and the reply stays
// unclassified.
//
// The reply judged must be the contact's first customer message since
// the recipient's send (the backfill picks exactly that message; the
// inbound path passes its message and is skipped otherwise), so a reply
// to a later campaign is never judged against an older, unanswered one.
//
// Never throws: a failure is logged with `[reply-class]` and the reply
// stays unclassified.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { writeConversationChatTags } from '@/lib/chat-tags/server';
import { getInsightSettings, insightsAvailable } from '@/lib/insights/settings';
import { getDecisionLayer } from '@/lib/typesafe';
import type { ReplyClass } from '@/lib/typesafe/questions/reply-class';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

export interface ClassifyCampaignReplyInput {
  accountId: string;
  recipientId: string;
  broadcastId: string;
  /** The customer's reply: typed text, or the tapped button's title. */
  replyText: string;
  /** The tapped button's title, when the reply was a tap. */
  tappedButton?: string | null;
  /**
   * Budget for the whole classification, its database reads included;
   * the Jev call gets what is left of it.
   */
  deadlineMs?: number;
  /**
   * The inbound path's message (messages.id) in `conversationId`: the
   * reply is judged only if it is the conversation's first customer
   * message since the recipient's send. The backfill omits both, having
   * picked that message itself.
   */
  inboundMessageId?: string;
  conversationId?: string;
}

export interface CampaignReplyClass {
  cls: ReplyClass;
  p: number;
}

/** An `interested` class at or above this tags the chat (pipeline). */
export const REPLY_INTERESTED_MIN_P = 0.7;

const logError = (what: string, err: unknown) =>
  console.error(
    `[reply-class] ${what}:`,
    err instanceof Error ? err.message : String(err)
  );

/** Below this much budget, Jev is not asked. */
const MIN_JUDGMENT_MS = 200;

/** What stands in for every template placeholder sent to Jev. */
export const CAMPAIGN_PLACEHOLDER = '[…]';

/** `{{1}}`, `{{ name }}`: any template placeholder, numbered or named. */
const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

/** Whether reply sorting runs for this account right now. Never throws. */
export async function replyClassOn(accountId: string): Promise<boolean> {
  try {
    if (!insightsAvailable(accountId)) return false;
    return (await getInsightSettings(accountId)).replyClassEnabled;
  } catch {
    return false;
  }
}

/**
 * The broadcast's text with neutral placeholders, and when the
 * recipient's send happened; null when there is nothing to judge
 * against.
 */
async function campaignContextFor(
  db: ReturnType<typeof supabaseAdmin>,
  input: Pick<
    ClassifyCampaignReplyInput,
    'accountId' | 'broadcastId' | 'recipientId'
  >
): Promise<{ campaignMessage: string; since: string } | null> {
  const [bRes, rRes] = await Promise.all([
    db
      .from('broadcasts')
      .select('id, template_name, template_language')
      .eq('id', input.broadcastId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('broadcast_recipients')
      .select('id, sent_at, created_at')
      .eq('id', input.recipientId)
      .eq('broadcast_id', input.broadcastId)
      .maybeSingle(),
  ]);
  if (bRes.error) throw new Error(bRes.error.message);
  if (rRes.error) throw new Error(rRes.error.message);
  const broadcast = bRes.data as {
    template_name: string | null;
    template_language: string | null;
  } | null;
  const recipient = rRes.data as {
    sent_at: string | null;
    created_at: string;
  } | null;
  if (!broadcast?.template_name || !recipient) return null;
  const { row } = await resolveTemplateRow(
    db,
    input.accountId,
    broadcast.template_name,
    broadcast.template_language
  );
  if (!row?.body_text) return null;
  return {
    campaignMessage: row.body_text.replace(PLACEHOLDER, CAMPAIGN_PLACEHOLDER),
    since: recipient.sent_at ?? recipient.created_at,
  };
}

/**
 * Is `messageId` the conversation's first customer message since `since`?
 * It is when no customer message since then is strictly older than it.
 * created_at is whole seconds (the gateway's timestamp), so two messages
 * can share one: picking "the earliest" by created_at alone could name
 * the second, and the real first then counted as not first while the
 * second found the recipient already replied, leaving the reply with no
 * class at all. With the strict rule both count, and the conditional
 * write lets only one store a class.
 */
async function isFirstReplySince(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  messageId: string,
  since: string
): Promise<boolean> {
  const { data: own, error: ownError } = await db
    .from('messages')
    .select('created_at')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (ownError) throw new Error(ownError.message);
  const at = (own as { created_at: string } | null)?.created_at;
  // Not since the send: not a reply to it (as before).
  if (!at || Date.parse(at) < Date.parse(since)) return false;
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gte('created_at', since)
    .lt('created_at', at)
    .limit(1);
  if (error) throw new Error(error.message);
  return !Array.isArray(data) || data.length === 0;
}

/**
 * Judge and store the class of one recipient's reply. Returns the class
 * stored, or null (feature off, nothing to judge against, not the first
 * reply since the send, out of budget, Jev failed, a class was already
 * stored, or the write failed). Never throws.
 */
export async function classifyCampaignReply(
  input: ClassifyCampaignReplyInput
): Promise<CampaignReplyClass | null> {
  const started = Date.now();
  try {
    const reply = input.replyText.trim();
    if (!reply) return null;
    if (!(await replyClassOn(input.accountId))) return null;
    const ts = getDecisionLayer();
    if (!ts) return null;

    const db = supabaseAdmin();
    const context = await campaignContextFor(db, input);
    if (!context) return null;
    if (
      input.inboundMessageId &&
      input.conversationId &&
      !(await isFirstReplySince(
        db,
        input.conversationId,
        input.inboundMessageId,
        context.since
      ))
    )
      return null;

    let deadlineMs = input.deadlineMs;
    if (deadlineMs !== undefined) {
      deadlineMs -= Date.now() - started;
      if (deadlineMs < MIN_JUDGMENT_MS) return null;
    }
    const judged = await ts.replyClass({
      accountId: input.accountId,
      campaignMessage: context.campaignMessage,
      reply,
      tappedButton: input.tappedButton ?? null,
      deadlineMs,
    });
    if (!judged.ok) return null;

    const p = Math.min(1, Math.max(0, judged.p));
    // Filtered by the broadcast, which was read inside the account; a
    // class already stored (a racing backfill) is never overwritten.
    const { data: written, error } = await db
      .from('broadcast_recipients')
      .update({
        reply_class: judged.cls,
        reply_class_p: p,
        reply_classified_at: new Date().toISOString(),
      })
      .eq('id', input.recipientId)
      .eq('broadcast_id', input.broadcastId)
      .is('reply_class', null)
      .select('id');
    if (error) {
      logError('write failed', error.message);
      return null;
    }
    if (!written?.length) return null;
    return { cls: judged.cls, p };
  } catch (err) {
    logError('classification failed', err);
    return null;
  }
}

export type InterestedTagResult =
  | 'not_interested'
  | 'no_tag'
  | 'applied'
  /** The chat already carried a main tag: a person's tag always wins. */
  | 'unchanged'
  | 'error';

/**
 * Tag an untagged chat whose campaign reply Jev judged `interested`
 * (p >= REPLY_INTERESTED_MIN_P) with the account's chosen main tag, the
 * way auto-tag.ts does: the same helper on the service role with
 * `onlyIfUntagged`, then the `chat_tag_set` automations (depth 0) when
 * the write changed something. Never throws.
 */
export async function tagInterestedReply(args: {
  accountId: string;
  conversationId: string;
  replyClass: CampaignReplyClass | null;
}): Promise<InterestedTagResult> {
  try {
    const rc = args.replyClass;
    if (!rc || rc.cls !== 'interested' || !(rc.p >= REPLY_INTERESTED_MIN_P))
      return 'not_interested';
    const tagId = (await getInsightSettings(args.accountId))
      .replyInterestedTagId;
    if (!tagId) return 'no_tag';
    const result = await writeConversationChatTags(supabaseAdmin(), {
      accountId: args.accountId,
      conversationId: args.conversationId,
      next: { chat_tag_id: tagId, chat_sub_tag_id: null },
      onlyIfUntagged: true,
    });
    if (!result.ok) {
      logError('interested tag write failed', result.message ?? result.reason);
      return 'error';
    }
    const { previous, saved } = result;
    if (
      previous.chat_tag_id === saved.chat_tag_id &&
      previous.chat_sub_tag_id === saved.chat_sub_tag_id
    )
      return 'unchanged';
    await dispatchChatTagSet({
      accountId: args.accountId,
      contactId: result.contactId,
      conversationId: result.conversationId,
      previous,
      saved,
    });
    return 'applied';
  } catch (err) {
    logError('interested tagging failed', err);
    return 'error';
  }
}
