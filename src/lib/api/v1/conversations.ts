// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
//
// The API keeps its own select rather than borrowing the inbox's, so a
// change to what the inbox screen embeds cannot change the public wire.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '@/lib/api/v1/respond';
import type { ChatTag, Conversation, Message } from '@/types';

/** Row select for the conversation endpoints: the row plus its contact. */
export const CONVERSATION_COLUMNS = '*, contact:contacts(*)';

export interface ApiChatTag {
  id: string;
  name: string;
  color: string;
}

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  /** The conversation's main chat tag, or null. */
  chat_tag: ApiChatTag | null;
  /** Its sub-tag, or null. Only ever a sub-tag of `chat_tag`. */
  chat_sub_tag: ApiChatTag | null;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    /** Deprecated: contact tags are retired. Always empty. */
    tags: { id: string; name: string; color: string }[];
    opted_out_at: string | null;
  } | null;
}

/** The chat tag columns the serializer needs. */
export type ChatTagRow = Pick<ChatTag, 'id' | 'name' | 'color' | 'parent_id'>;

/** An account's chat tags by id. */
export type ChatTagLookup = ReadonlyMap<string, ChatTagRow>;

export function chatTagLookup(rows: readonly ChatTagRow[]): ChatTagLookup {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Read the account's chat tags once for a page of conversations. Ids
 * are mapped in the serializer rather than embedded by PostgREST:
 * `conversations` has two foreign keys to `chat_tags`, and an embed
 * would need FK hints. Skips the read when no row carries a tag.
 */
export async function loadChatTagLookup(
  db: SupabaseClient,
  accountId: string,
  convs: readonly Pick<Conversation, 'chat_tag_id'>[]
): Promise<ChatTagLookup> {
  if (!convs.some((c) => c.chat_tag_id)) return new Map();
  const { data, error } = await db
    .from('chat_tags')
    .select('id, name, color, parent_id')
    .eq('account_id', accountId);
  if (error) {
    console.error('[api/v1/conversations] chat tag read error:', error);
    throw new ApiError('internal', 'Failed to read chat tags', 500);
  }
  return chatTagLookup((data ?? []) as ChatTagRow[]);
}

function toApiChatTag(tag: ChatTagRow): ApiChatTag {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/**
 * Same rule as `resolveConversationChatTags`: the main tag shows only
 * when the id is a known main tag, and the sub-tag only when it is a
 * known tag under that main tag. A stale id resolves to null.
 */
function resolveChatTags(
  conv: Pick<Conversation, 'chat_tag_id' | 'chat_sub_tag_id'>,
  lookup: ChatTagLookup
): { main: ChatTagRow | null; sub: ChatTagRow | null } {
  const found = conv.chat_tag_id ? lookup.get(conv.chat_tag_id) : undefined;
  const main = found && found.parent_id === null ? found : null;
  if (!main || !conv.chat_sub_tag_id) return { main, sub: null };
  const sub = lookup.get(conv.chat_sub_tag_id);
  return { main, sub: sub && sub.parent_id === main.id ? sub : null };
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/**
 * Project a `CONVERSATION_COLUMNS` row into the public shape, naming
 * its chat tags from `chatTags` (see {@link loadChatTagLookup}).
 */
export function serializeConversation(
  conv: Conversation,
  chatTags: ChatTagLookup
): ApiConversation {
  const c = conv.contact;
  const { main, sub } = resolveChatTags(conv, chatTags);
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    chat_tag: main ? toApiChatTag(main) : null,
    chat_sub_tag: sub ? toApiChatTag(sub) : null,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: [],
          opted_out_at: c.opted_out_at ?? null,
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}
