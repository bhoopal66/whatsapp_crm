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
// body rendered with that recipient's frozen params (migration 038),
// else the bare body. With no local template row there is nothing to
// judge against, and the reply stays unclassified.
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
import {
  renderTemplateBody,
  resolveTemplateRow,
} from '@/lib/whatsapp/template-body';

export interface ClassifyCampaignReplyInput {
  accountId: string;
  recipientId: string;
  broadcastId: string;
  /** The customer's reply: typed text, or the tapped button's title. */
  replyText: string;
  /** The tapped button's title, when the reply was a tap. */
  tappedButton?: string | null;
  /** Hard deadline for the judgment. */
  deadlineMs?: number;
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

/** Whether reply sorting runs for this account right now. Never throws. */
export async function replyClassOn(accountId: string): Promise<boolean> {
  try {
    if (!insightsAvailable(accountId)) return false;
    return (await getInsightSettings(accountId)).replyClassEnabled;
  } catch {
    return false;
  }
}

/** The broadcast's text as this recipient saw it, or null. */
async function campaignMessageFor(
  db: ReturnType<typeof supabaseAdmin>,
  input: Pick<
    ClassifyCampaignReplyInput,
    'accountId' | 'broadcastId' | 'recipientId'
  >
): Promise<string | null> {
  const [bRes, rRes] = await Promise.all([
    db
      .from('broadcasts')
      .select('id, template_name, template_language')
      .eq('id', input.broadcastId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('broadcast_recipients')
      .select('id, template_params')
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
  if (!broadcast?.template_name || !rRes.data) return null;
  const { row } = await resolveTemplateRow(
    db,
    input.accountId,
    broadcast.template_name,
    broadcast.template_language
  );
  if (!row?.body_text) return null;
  const raw = (rRes.data as { template_params?: unknown }).template_params;
  const params = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : [];
  return renderTemplateBody(row.body_text, params);
}

/**
 * Judge and store the class of one recipient's reply. Returns the class
 * stored, or null (feature off, nothing to judge against, Jev failed, or
 * the write failed). Never throws.
 */
export async function classifyCampaignReply(
  input: ClassifyCampaignReplyInput
): Promise<CampaignReplyClass | null> {
  try {
    const reply = input.replyText.trim();
    if (!reply) return null;
    if (!(await replyClassOn(input.accountId))) return null;
    const ts = getDecisionLayer();
    if (!ts) return null;

    const db = supabaseAdmin();
    const campaignMessage = await campaignMessageFor(db, input);
    if (!campaignMessage) return null;

    const judged = await ts.replyClass({
      accountId: input.accountId,
      campaignMessage,
      reply,
      tappedButton: input.tappedButton ?? null,
      deadlineMs: input.deadlineMs,
    });
    if (!judged.ok) return null;

    const p = Math.min(1, Math.max(0, judged.p));
    // Filtered by the broadcast, which was read inside the account; a
    // class already stored (a racing backfill) is never overwritten.
    const { error } = await db
      .from('broadcast_recipients')
      .update({
        reply_class: judged.cls,
        reply_class_p: p,
        reply_classified_at: new Date().toISOString(),
      })
      .eq('id', input.recipientId)
      .eq('broadcast_id', input.broadcastId)
      .is('reply_class', null);
    if (error) {
      logError('write failed', error.message);
      return null;
    }
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
