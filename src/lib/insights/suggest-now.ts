// ============================================================
// "Suggest a tag" on demand (docs/jev-insights.md, "Chat tag
// suggestions").
//
// The same tag question the inbound run asks, for a chat a person has
// open: the latest customer message with the turns before it, over the
// workspace's own tags. The answer goes through the same rules
// (`suggestionFor`) and is stored or cleared exactly as the inbound run
// would. It never tags the chat, in Auto mode either: applying is the
// person's click.
//
// The caller (an API route) checks the person's access to the chat
// first; this runs on the service role. Never throws.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { buildConversationContext } from '@/lib/ai/context';
import { getDecisionLayer } from '@/lib/typesafe';
import { TAG_SUGGEST_MIN_P } from './bands';
import {
  loadTagCatalogue,
  suggestionFor,
  type ChatTagState,
  type StoredSuggestion,
} from './inbound';
import { getInsightSettings, insightsAvailable } from './settings';

/** Earlier turns sent with the message, as the inbound run sends them. */
const RECENT_TURNS = 6;

export type SuggestTagResult =
  | {
      ok: true;
      suggestion: StoredSuggestion | null;
      /** Why there is no suggestion (absent when there is one). */
      reason?:
        | 'no_tags'
        | 'no_message'
        | 'not_confident'
        | 'same_as_current'
        | 'dismissed';
    }
  | { ok: false; reason: 'unavailable' | 'off' | 'error' };

export async function suggestTagForConversation(
  accountId: string,
  conversationId: string
): Promise<SuggestTagResult> {
  try {
    if (!insightsAvailable(accountId))
      return { ok: false, reason: 'unavailable' };
    const ts = getDecisionLayer();
    if (!ts) return { ok: false, reason: 'unavailable' };
    const settings = await getInsightSettings(accountId);
    if (settings.tagSuggestMode === 'off') return { ok: false, reason: 'off' };

    const db = supabaseAdmin();
    const [catalogue, chatRes] = await Promise.all([
      loadTagCatalogue(db, accountId),
      db
        .from('conversations')
        .select('chat_tag_id, chat_sub_tag_id, tag_suggestion_dismissed_id')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle(),
    ]);
    if (chatRes.error) throw new Error(chatRes.error.message);
    if (!chatRes.data) throw new Error('conversation not found');
    const row = chatRes.data as {
      chat_tag_id: string | null;
      chat_sub_tag_id: string | null;
      tag_suggestion_dismissed_id: string | null;
    };
    const chat: ChatTagState = {
      chatTagId: row.chat_tag_id,
      chatSubTagId: row.chat_sub_tag_id,
      dismissedId: row.tag_suggestion_dismissed_id,
    };
    if (catalogue.mains.length === 0)
      return { ok: true, suggestion: null, reason: 'no_tags' };

    const context = await buildConversationContext(db, conversationId);
    let last = -1;
    for (let i = context.length - 1; i >= 0; i--) {
      if (context[i]!.role === 'user' && context[i]!.content.trim()) {
        last = i;
        break;
      }
    }
    if (last < 0) return { ok: true, suggestion: null, reason: 'no_message' };

    const judgment = await ts.insights({
      accountId,
      message: context[last]!.content,
      recentTurns: context
        .slice(0, last)
        .slice(-RECENT_TURNS)
        .map((m) => ({
          from: m.role === 'user' ? 'customer' : 'taamul',
          text: m.content,
        })),
      journeyStage: 'open_conversation',
      askSignals: false,
      tags: catalogue,
    });
    // A failed judgment stores nothing: the chip keeps what it had.
    if (!judgment.ok || !judgment.tag) return { ok: false, reason: 'error' };
    const tag = judgment.tag;

    const next = suggestionFor(tag, chat);
    const { error } = await db
      .from('conversations')
      .update(
        next
          ? {
              suggested_chat_tag_id: next.mainId,
              suggested_chat_sub_tag_id: next.subId,
              suggested_tag_p: next.p,
              suggested_tag_at: new Date().toISOString(),
            }
          : {
              suggested_chat_tag_id: null,
              suggested_chat_sub_tag_id: null,
              suggested_tag_p: null,
              suggested_tag_at: null,
            }
      )
      .eq('id', conversationId)
      .eq('account_id', accountId);
    if (error) throw new Error(error.message);

    if (next) return { ok: true, suggestion: next };
    // Why suggestionFor said no, in its own order.
    const reason =
      !tag.mainId || !(tag.mainP >= TAG_SUGGEST_MIN_P)
        ? 'not_confident'
        : tag.mainId === chat.dismissedId
          ? 'dismissed'
          : 'same_as_current';
    return { ok: true, suggestion: null, reason };
  } catch (err) {
    console.error(
      '[insights] suggest a tag failed:',
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false, reason: 'error' };
  }
}
