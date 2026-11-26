// ============================================================
// Fire `chat_tag_set` automations after a chat's tags were written.
//
// Callers pass the tags read before the write and the row the database
// returned (`writeConversationChatTags`). Nothing changed — a re-save,
// or a pick the database refused to apply — dispatches nothing; which
// automations the change matches is the engine's call
// (`chatTagTriggerMatches`).
//
// `depth` is the caller's own chain depth (0, or absent, for a person's
// pick). The dispatched context carries depth + 1 in
// `vars._chat_tag_chain_depth`, the way `_tag_chain_depth` travels for
// contact tags, so a `set_chat_tag` step can stop a loop.
//
// `salesChat` is the decision of the inbound message that set the tag.
// Without one (a person's pick, a flow's tag step) it is read here, only
// when a message step asks: in a chat that is not a sales chat no message
// step runs, the internal steps do.
//
// Awaits the engine, which never throws; run it inside `after()`.
// ============================================================

import { salesChatOnce, type SalesChatCheck } from '@/lib/ai/not-sales-chat';
import type { ChatTagsPatch } from '@/types';

import { supabaseAdmin } from './admin-client';
import { runAutomationsForTrigger } from './engine';

export async function dispatchChatTagSet(args: {
  accountId: string;
  contactId: string;
  conversationId: string;
  previous: ChatTagsPatch;
  saved: ChatTagsPatch;
  depth?: number;
  salesChat?: SalesChatCheck | null;
}): Promise<void> {
  const { previous, saved } = args;
  if (
    previous.chat_tag_id === saved.chat_tag_id &&
    previous.chat_sub_tag_id === saved.chat_sub_tag_id
  ) {
    return;
  }

  await runAutomationsForTrigger({
    accountId: args.accountId,
    triggerType: 'chat_tag_set',
    contactId: args.contactId,
    salesChat:
      args.salesChat ??
      salesChatOnce(supabaseAdmin, {
        conversationId: args.conversationId,
        inboundChannelId: null,
      }),
    context: {
      conversation_id: args.conversationId,
      chat_tag_id: saved.chat_tag_id,
      chat_sub_tag_id: saved.chat_sub_tag_id,
      previous_chat_tag_id: previous.chat_tag_id,
      previous_chat_sub_tag_id: previous.chat_sub_tag_id,
      vars: { _chat_tag_chain_depth: (args.depth ?? 0) + 1 },
    },
  });
}
