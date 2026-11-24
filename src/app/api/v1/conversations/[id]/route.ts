// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_COLUMNS,
  loadChatTagLookup,
  serializeConversation,
} from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      // A personal chat answers 404, as if it did not exist.
      .is('personal_owner_id', null)
      .maybeSingle();

    // 22P02: not a uuid, so nothing has that id.
    if (error && error.code !== '22P02') {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    const conv = data as Conversation;
    const chatTags = await loadChatTagLookup(ctx.supabase, ctx.accountId, [
      conv,
    ]);
    return ok(serializeConversation(conv, chatTags));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
