// ============================================================
// Automatic chat tagging (docs/jev-insights.md, "Chat tag suggestions").
//
// Runs right after runInboundInsights, on its outcome, inside the same
// after() chain of the inbound pipeline. In Auto mode a chat with no
// main tag gets the main tag Jev is at least `tagAutoMinP` sure of
// (and its sub-tag only when Jev is as sure of that), unless a person
// dismissed that tag for this chat.
//
// The write is the same helper the inbox header uses, on the service
// role, with `onlyIfUntagged`: a person who tags the chat first always
// wins, and a tag a person set is never changed. A real change then
// does what a manual tag does — the `chat_tag_set` automations run
// (depth 0, as a person's pick) and the database's deal trigger fires
// on the UPDATE itself — and leaves a `chat_tag_auto` note in the
// thread (ids and probability only, never customer text). The
// suggestion columns are cleared: the chat now carries the tag.
//
// Never throws; a failure is logged with `[insights]`.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { writeConversationChatTags } from '@/lib/chat-tags/server';
import type { InboundInsightsOutcome } from './inbound';

export type AutoTagResult =
  /** Not Auto mode, or the insights run stopped early / failed. */
  | 'not_auto'
  /** No main tag, or one below the auto threshold. */
  | 'not_confident'
  /** The chat already had a main tag when insights read it. */
  | 'already_tagged'
  /** A person dismissed this tag for this chat. */
  | 'dismissed'
  | 'applied'
  /** The write found the chat tagged meanwhile (or already there). */
  | 'unchanged'
  | 'error';

/** The note's payload, stored in `conversation_events.to_label`. */
export interface AutoTagNote {
  chat_tag_id: string;
  chat_sub_tag_id: string | null;
  p: number;
}

const logError = (what: string, err: unknown) =>
  console.error(
    `[insights] ${what}:`,
    err instanceof Error ? err.message : String(err)
  );

/** Apply the judged tag to an untagged chat in Auto mode. Never throws. */
export async function autoTagFromInsights(
  args: { accountId: string; conversationId: string; contactId: string },
  outcome: InboundInsightsOutcome
): Promise<AutoTagResult> {
  try {
    const { settings, tag, chat } = outcome;
    if (
      outcome.skipped !== null ||
      !settings ||
      settings.tagSuggestMode !== 'auto' ||
      !chat
    )
      return 'not_auto';
    const min = settings.tagAutoMinP;
    if (!tag || !tag.mainId || !(tag.mainP >= min)) return 'not_confident';
    if (chat.chatTagId !== null) return 'already_tagged';
    if (tag.mainId === chat.dismissedId) return 'dismissed';
    const subId =
      tag.subId && typeof tag.subP === 'number' && tag.subP >= min
        ? tag.subId
        : null;

    const db = supabaseAdmin();
    const result = await writeConversationChatTags(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      next: { chat_tag_id: tag.mainId, chat_sub_tag_id: subId },
      onlyIfUntagged: true,
    });
    if (!result.ok) {
      logError('automatic tag write failed', result.message ?? result.reason);
      return 'error';
    }
    const { previous, saved } = result;
    if (
      previous.chat_tag_id === saved.chat_tag_id &&
      previous.chat_sub_tag_id === saved.chat_sub_tag_id
    )
      return 'unchanged';

    // The note and the suggestion clear are display data: a failure is
    // logged and does not stop the automations a manual tag would run.
    const note: AutoTagNote = {
      chat_tag_id: saved.chat_tag_id ?? tag.mainId,
      chat_sub_tag_id: saved.chat_sub_tag_id,
      p: tag.mainP,
    };
    const [noteRes, clearRes] = await Promise.all([
      db.from('conversation_events').insert({
        account_id: args.accountId,
        conversation_id: result.conversationId,
        kind: 'chat_tag_auto',
        actor_user_id: null,
        to_label: JSON.stringify(note),
      }),
      db
        .from('conversations')
        .update({
          suggested_chat_tag_id: null,
          suggested_chat_sub_tag_id: null,
          suggested_tag_p: null,
          suggested_tag_at: null,
        })
        .eq('id', result.conversationId)
        .eq('account_id', args.accountId),
    ]);
    if (noteRes.error)
      logError('automatic tag note failed', noteRes.error.message);
    if (clearRes.error)
      logError('suggestion clear failed', clearRes.error.message);

    await dispatchChatTagSet({
      accountId: args.accountId,
      contactId: result.contactId,
      conversationId: result.conversationId,
      previous,
      saved,
    });
    return 'applied';
  } catch (err) {
    logError('automatic tagging failed', err);
    return 'error';
  }
}
