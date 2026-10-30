import { createClient } from '@/lib/supabase/client';
import {
  MESSAGE_PAGE_SELECT,
  MESSAGE_PAGE_SIZE,
  type MessageWithReactions,
} from '@/lib/inbox/pagination';
import {
  messagePageFromRows,
  type CachedMessagePage,
} from '@/lib/inbox/message-cache';

/**
 * The latest page of a thread with each message's reactions embedded —
 * one round trip for what used to be two unbounded ones (every message,
 * every reaction in the conversation). `id` breaks created_at ties so
 * the keyset cursor can't skip a row. Rejects on a read error, so the
 * session cache keeps what it held. The one fetcher behind both the
 * thread and the list's hover prefetch, so the two share one request.
 */
export async function fetchLatestMessagePage(
  conversationId: string
): Promise<CachedMessagePage> {
  const { data, error } = await createClient()
    .from('messages')
    .select(MESSAGE_PAGE_SELECT)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
  if (error) throw error;
  return messagePageFromRows((data ?? []) as MessageWithReactions[]);
}
