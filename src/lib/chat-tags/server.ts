// ============================================================
// Server-side writer for a chat's tags (migration 075). Server use
// only: the caller hands in the client whose rights the write should
// run under — the caller's RLS client from a route, the service role
// from an automation.
//
// It reads the chat's current tags first so the caller can tell what
// changed (a `chat_tag_set` automation fires on arrival, not on
// presence), then writes and reports the row the database returned:
// the guard trigger may have cleared the sub-tag, and RLS answers a
// refused UPDATE with no row rather than an error. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChatTagsPatch } from '@/types';

export type WriteChatTagsResult =
  | {
      ok: true;
      conversationId: string;
      contactId: string;
      previous: ChatTagsPatch;
      saved: ChatTagsPatch;
    }
  | { ok: false; reason: 'not_found' | 'invalid' | 'error'; message?: string };

const COLUMNS = 'id, contact_id, chat_tag_id, chat_sub_tag_id';

interface ChatTagRow {
  id: string;
  contact_id: string;
  chat_tag_id: string | null;
  chat_sub_tag_id: string | null;
}

function toPatch(row: ChatTagRow): ChatTagsPatch {
  return {
    chat_tag_id: row.chat_tag_id ?? null,
    chat_sub_tag_id: row.chat_sub_tag_id ?? null,
  };
}

function failure(error: { code?: string; message?: string }) {
  // 23514: the 075 guard trigger (a sub-tag of another main tag, a sub-
  // tag used as a main tag). 23503: a tag id that is not this account's.
  if (error.code === '23514' || error.code === '23503') {
    return {
      ok: false as const,
      reason: 'invalid' as const,
      message: error.message,
    };
  }
  return {
    ok: false as const,
    reason: 'error' as const,
    message: error.message,
  };
}

export async function writeConversationChatTags(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId?: string;
    contactId?: string;
    next: ChatTagsPatch;
  }
): Promise<WriteChatTagsResult> {
  try {
    if (!args.conversationId && !args.contactId) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'A conversation or contact id is required',
      };
    }

    let read = db
      .from('conversations')
      .select(COLUMNS)
      .eq('account_id', args.accountId);
    read = args.conversationId
      ? read.eq('id', args.conversationId)
      : // One conversation per contact; should there ever be more, the
        // most recently active one is the chat a person would mean.
        read
          .eq('contact_id', args.contactId as string)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1);
    const { data: current, error: readError } = await read.maybeSingle();
    if (readError) return failure(readError);
    if (!current) return { ok: false, reason: 'not_found' };
    const row = current as ChatTagRow;

    const { data: written, error: writeError } = await db
      .from('conversations')
      .update({
        chat_tag_id: args.next.chat_tag_id,
        chat_sub_tag_id: args.next.chat_sub_tag_id,
      })
      .eq('id', row.id)
      .eq('account_id', args.accountId)
      .select(COLUMNS)
      .maybeSingle();
    if (writeError) return failure(writeError);
    // No row back is RLS refusing the UPDATE (or the chat vanished).
    if (!written) return { ok: false, reason: 'not_found' };
    const saved = written as ChatTagRow;

    return {
      ok: true,
      conversationId: saved.id,
      contactId: saved.contact_id,
      previous: toPatch(row),
      saved: toPatch(saved),
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
