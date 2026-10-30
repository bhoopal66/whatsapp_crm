// A contact's WhatsApp thread as the contact screens need it: which
// number it is pinned to or lives on, the last message that reached
// WhatsApp, and its chat tag. Mirrors `describeChannel` server-side,
// minus the encryption import.
//
// The conversation rows come from the customer page's own conversations
// read (`startCustomerLoad` in customer-load.ts), so the page reads the
// table once; only the last message is a read of its own.

import type { SupabaseClient } from '@supabase/supabase-js';

import { chatTagsByContact, type ChatTagIds } from './chat-tag-column';

export interface ContactThread {
  /** The person's pin on the chat (migration 061); null: automatic. */
  pin: string | null;
  /** The number the thread is on (`conversations.channel_id`). */
  home: string | null;
  /** The last message that reached WhatsApp; null: none. */
  last: { at: string; byCustomer: boolean } | null;
  /** The chat tag (migration 075), picked as the contacts list picks
   *  it; null: no thread. */
  chatTags: ChatTagIds | null;
}

export const NO_THREAD: ContactThread = {
  pin: null,
  home: null,
  last: null,
  chatTags: null,
};

/** The columns `contactThreadFrom` needs from each conversation row. */
export const THREAD_COLUMNS =
  'contact_id, channel_id, send_channel_id, chat_tag_id, chat_sub_tag_id';

export interface ThreadRow extends ChatTagIds {
  contact_id: string;
  channel_id: string | null;
  send_channel_id: string | null;
}

export interface LastMessage {
  sender_type: string;
  created_at: string;
}

/**
 * The thread from the contact's conversation rows, **oldest first**:
 * the send-number fields come from the oldest thread, the chat tag
 * from the first thread that carries one (what the contacts list shows
 * and filters on).
 */
export function contactThreadFrom(
  rows: readonly ThreadRow[],
  contactId: string,
  last: LastMessage | null
): ContactThread {
  const first = rows[0] ?? null;
  return {
    pin: first?.send_channel_id ?? null,
    home: first?.channel_id ?? null,
    last: last?.created_at
      ? { at: last.created_at, byCustomer: last.sender_type === 'customer' }
      : null,
    chatTags: first ? (chatTagsByContact(rows).get(contactId) ?? null) : null,
  };
}

/**
 * The last message that went out or came in (failed sends aside):
 * whether a message from here would start a chat (Team activity,
 * migration 068) turns on it and on who sent it. Best-effort: null on
 * a failed read.
 */
export async function readLastMessage(
  supabase: SupabaseClient,
  conversationId: string
): Promise<LastMessage | null> {
  const { data } = await supabase
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conversationId)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LastMessage | null) ?? null;
}
