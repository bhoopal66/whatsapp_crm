// A contact's WhatsApp thread as the contact screens need it: which
// number it is pinned to or lives on, the last message that reached
// WhatsApp, and its chat tag. Mirrors `describeChannel` server-side,
// minus the encryption import.

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

/** Reads a contact's thread through the caller's (RLS) client. */
export async function loadContactThread(
  supabase: SupabaseClient,
  contactId: string
): Promise<ContactThread> {
  // Oldest first. The send-number fields come from the oldest
  // thread, as before; the chat tag from the first thread that
  // carries one, which is what the contacts list shows and filters on.
  const { data: rows } = await supabase
    .from('conversations')
    .select(
      'id, contact_id, channel_id, send_channel_id, chat_tag_id, chat_sub_tag_id'
    )
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true });
  const data = rows?.[0] ?? null;
  // Whether a message from here would start a chat (Team activity,
  // migration 068) turns on the last message that went out or came
  // in, and on who sent it.
  const { data: lastRow } = data?.id
    ? await supabase
        .from('messages')
        .select('sender_type, created_at')
        .eq('conversation_id', data.id as string)
        .neq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  return {
    pin: (data?.send_channel_id as string | null) ?? null,
    home: (data?.channel_id as string | null) ?? null,
    last: lastRow?.created_at
      ? {
          at: lastRow.created_at as string,
          byCustomer: lastRow.sender_type === 'customer',
        }
      : null,
    chatTags: data
      ? (chatTagsByContact(rows as (ChatTagIds & { contact_id: string })[]).get(
          contactId
        ) ?? null)
      : null,
  };
}
