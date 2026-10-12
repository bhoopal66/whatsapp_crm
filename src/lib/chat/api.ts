/**
 * Typed wrappers over the chat RPCs and tables of migration 087. The
 * browser calls them with the user's session: every RPC is SECURITY
 * DEFINER and re-checks the caller, RLS limits every read, so there is
 * no API route in between. Every failure is thrown as a ChatError.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { toChatError } from './errors';
import { isUuid } from './mentions';
import {
  toAttachment,
  toChannel,
  toChannelMember,
  toChatMessage,
  toChatPerson,
  toPin,
  toSearchHit,
  toSharedCard,
  toUnreadCount,
  toWorkspaceBadge,
  type AttachmentInput,
  type ChannelMember,
  type ChannelWithMembership,
  type ChatAttachment,
  type ChatMessage,
  type ChatPerson,
  type MessagePage,
  type Pin,
  type ReactionSummary,
  type SearchHit,
  type SharedCard,
  type ThreadSummary,
  type UnreadCount,
  type WorkspaceBadge,
} from './types';
import { summarizeReplies } from './message-list';

type Row = Record<string, unknown>;

/** internal_messages without the generated `search` tsvector. */
export const MESSAGE_COLUMNS =
  'id,channel_id,account_id,thread_root_id,author_kind,author_id,body,meta,created_at,edited_at,deleted_at,erased_at';

async function rpc<T>(sb: SupabaseClient, fn: string, args?: Row): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw toChatError(error);
  return data as T;
}

async function rows(
  query: PromiseLike<{ data: unknown; error: unknown }>
): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw toChatError(error);
  return (data as Row[] | null) ?? [];
}

// ---------- RPCs ----------

export const createChannel = (
  sb: SupabaseClient,
  i: {
    accountId: string;
    kind: 'team' | 'private';
    name: string;
    topic?: string | null;
    memberIds?: string[];
  }
): Promise<string> =>
  rpc(sb, 'chat_create_channel', {
    p_ws: i.accountId,
    p_kind: i.kind,
    p_name: i.name,
    p_topic: i.topic ?? null,
    p_member_ids: i.memberIds ?? [],
  });

/** Opens (or reopens) the DM of the caller plus `memberIds` (2–8 people in all). */
export const openDm = (
  sb: SupabaseClient,
  i: { accountId: string; memberIds: string[] }
): Promise<string> =>
  rpc(sb, 'chat_open_dm', { p_ws: i.accountId, p_member_ids: i.memberIds });

export const postMessage = (
  sb: SupabaseClient,
  i: {
    channelId: string;
    body: string;
    threadRootId?: string | null;
    shareConversationId?: string | null;
    attachments?: AttachmentInput[];
  }
): Promise<string> =>
  rpc(sb, 'chat_post_message', {
    p_channel: i.channelId,
    p_body: i.body,
    p_thread_root: i.threadRootId ?? null,
    p_share_conversation: i.shareConversationId ?? null,
    p_attachments: i.attachments ?? [],
  });

export const editMessage = (
  sb: SupabaseClient,
  i: { messageId: string; body: string }
): Promise<void> =>
  rpc(sb, 'chat_edit_message', { p_message: i.messageId, p_body: i.body });

/** Soft delete; returns the storage paths of the attachments it dropped. */
export const deleteMessage = async (
  sb: SupabaseClient,
  messageId: string
): Promise<string[]> =>
  (await rpc<string[] | null>(sb, 'chat_delete_message', {
    p_message: messageId,
  })) ?? [];

/** Marks the channel read up to `at` (default: now, server time). */
export const markRead = (
  sb: SupabaseClient,
  channelId: string,
  at?: string
): Promise<void> =>
  rpc(
    sb,
    'chat_mark_read',
    at ? { p_channel: channelId, p_at: at } : { p_channel: channelId }
  );

export const unreadCounts = async (
  sb: SupabaseClient,
  accountId: string
): Promise<UnreadCount[]> =>
  (
    (await rpc<Row[] | null>(sb, 'chat_unread_counts', { p_ws: accountId })) ??
    []
  ).map(toUnreadCount);

export const workspaceBadges = async (
  sb: SupabaseClient
): Promise<WorkspaceBadge[]> =>
  ((await rpc<Row[] | null>(sb, 'chat_workspace_badges')) ?? []).map(
    toWorkspaceBadge
  );

export const searchMessages = async (
  sb: SupabaseClient,
  i: { accountId: string; query: string; limit?: number }
): Promise<SearchHit[]> =>
  (
    (await rpc<Row[] | null>(sb, 'chat_search', {
      p_ws: i.accountId,
      p_q: i.query,
      p_limit: i.limit ?? 50,
    })) ?? []
  ).map(toSearchHit);

/** true = the reaction was added, false = removed. */
export const toggleReaction = (
  sb: SupabaseClient,
  messageId: string,
  emoji: string
): Promise<boolean> =>
  rpc(sb, 'chat_toggle_reaction', { p_message: messageId, p_emoji: emoji });

export const setPin = (
  sb: SupabaseClient,
  messageId: string,
  pinned: boolean
): Promise<void> =>
  rpc(sb, 'chat_set_pin', { p_message: messageId, p_pinned: pinned });

export const setSaved = (
  sb: SupabaseClient,
  messageId: string,
  saved: boolean
): Promise<void> =>
  rpc(sb, 'chat_set_saved', { p_message: messageId, p_saved: saved });

export const sharedCards = async (
  sb: SupabaseClient,
  messageIds: string[]
): Promise<SharedCard[]> =>
  messageIds.length === 0
    ? []
    : (
        (await rpc<Row[] | null>(sb, 'chat_shared_cards', {
          p_message_ids: messageIds,
        })) ?? []
      ).map(toSharedCard);

export const chatPeople = async (
  sb: SupabaseClient,
  accountId: string
): Promise<ChatPerson[]> =>
  ((await rpc<Row[] | null>(sb, 'chat_people', { p_ws: accountId })) ?? []).map(
    toChatPerson
  );

/** Returns how many were added (already-members are skipped). */
export const addMembers = (
  sb: SupabaseClient,
  channelId: string,
  userIds: string[]
): Promise<number> =>
  rpc(sb, 'chat_add_members', { p_channel: channelId, p_user_ids: userIds });

export const leaveChannel = (
  sb: SupabaseClient,
  channelId: string
): Promise<void> => rpc(sb, 'chat_leave_channel', { p_channel: channelId });

export const setMemberRole = (
  sb: SupabaseClient,
  i: { channelId: string; userId: string; role: 'admin' | 'member' }
): Promise<void> =>
  rpc(sb, 'chat_set_member_role', {
    p_channel: i.channelId,
    p_user_id: i.userId,
    p_role: i.role,
  });

/** Owner/admin read of a private channel, DM or deal room; audited. Oldest first. */
export const adminReadPrivate = async (
  sb: SupabaseClient,
  i: { channelId: string; reason: string }
): Promise<ChatMessage[]> =>
  (
    (await rpc<Row[] | null>(sb, 'chat_admin_read_private', {
      p_channel: i.channelId,
      p_reason: i.reason,
    })) ?? []
  ).map(toChatMessage);

/** Owner-only erasure; returns the storage paths of the removed attachments. */
export const erasePerson = async (
  sb: SupabaseClient,
  i: { accountId: string; userId: string; reason: string }
): Promise<string[]> =>
  (await rpc<string[] | null>(sb, 'chat_erase_person', {
    p_ws: i.accountId,
    p_user_id: i.userId,
    p_reason: i.reason,
  })) ?? [];

// ---------- table reads (RLS decides what comes back) ----------

/**
 * The channels of the workspace the caller can see, each with the
 * caller's own membership row (embedded and filtered to `userId`).
 */
export async function listChannels(
  sb: SupabaseClient,
  accountId: string,
  userId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<ChannelWithMembership[]> {
  let q = sb
    .from('chat_channels')
    .select('*, me:chat_channel_members(*)')
    .eq('account_id', accountId)
    .eq('me.user_id', userId);
  if (!opts.includeArchived) q = q.is('archived_at', null);
  return (await rows(q.order('created_at'))).map((r) => {
    const me = Array.isArray(r.me) ? (r.me as Row[]) : [];
    return {
      ...toChannel(r),
      membership: me[0] ? toChannelMember(me[0]) : null,
    };
  });
}

const TS_RE = /^[0-9TZ:.+\- ]+$/;

/**
 * The newest page of a channel's top-level messages (or of one thread's
 * replies), older than `before` when given; returned oldest first.
 * Deleted messages are included as tombstones.
 */
export async function listMessages(
  sb: SupabaseClient,
  channelId: string,
  opts: {
    before?: { createdAt: string; id: string };
    limit?: number;
    threadRootId?: string;
  } = {}
): Promise<MessagePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  let q = sb
    .from('internal_messages')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId);
  q = opts.threadRootId
    ? q.eq('thread_root_id', opts.threadRootId)
    : q.is('thread_root_id', null);
  if (opts.before) {
    const { createdAt, id } = opts.before;
    if (!TS_RE.test(createdAt) || !isUuid(id))
      throw new TypeError('listMessages: bad cursor');
    q = q.or(
      `created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`
    );
  }
  const data = await rows(
    q
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
  );
  return {
    messages: data.slice(0, limit).reverse().map(toChatMessage),
    hasMore: data.length > limit,
  };
}

const PAGE = 1000; // PostgREST's default max-rows

/** Reply count, last reply time and up to 3 recent authors per root that has (undeleted) replies. */
export async function threadSummaries(
  sb: SupabaseClient,
  rootIds: string[]
): Promise<Record<string, ThreadSummary>> {
  if (rootIds.length === 0) return {};
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await rows(
      sb
        .from('internal_messages')
        .select('id,thread_root_id,author_id,created_at')
        .in('thread_root_id', rootIds)
        .is('deleted_at', null)
        .order('created_at')
        .order('id')
        .range(from, from + PAGE - 1)
    );
    all.push(...page);
    if (page.length < PAGE) break;
  }
  const byRoot = new Map<
    string,
    { id: string; authorId: string | null; createdAt: string }[]
  >();
  for (const r of all) {
    const root = String(r.thread_root_id);
    const list = byRoot.get(root) ?? [];
    list.push({
      id: String(r.id),
      authorId: r.author_id == null ? null : String(r.author_id),
      createdAt: String(r.created_at),
    });
    byRoot.set(root, list);
  }
  const out: Record<string, ThreadSummary> = {};
  for (const [root, refs] of byRoot) {
    const s = summarizeReplies(refs);
    if (s) out[root] = s;
  }
  return out;
}

/** Reactions per message, grouped by emoji in order of the first reaction. */
export async function reactionsFor(
  sb: SupabaseClient,
  messageIds: string[]
): Promise<Record<string, ReactionSummary[]>> {
  if (messageIds.length === 0) return {};
  const data = await rows(
    sb
      .from('internal_message_reactions')
      .select('message_id,user_id,emoji,created_at')
      .in('message_id', messageIds)
      .order('created_at')
  );
  const out: Record<string, ReactionSummary[]> = {};
  for (const r of data) {
    const list = (out[String(r.message_id)] ??= []);
    const emoji = String(r.emoji);
    let s = list.find((x) => x.emoji === emoji);
    if (!s) list.push((s = { emoji, count: 0, userIds: [] }));
    s.userIds.push(String(r.user_id));
    s.count = s.userIds.length;
  }
  return out;
}

/** Pins of a channel, newest first, with the pinned message embedded. */
export async function pinsFor(
  sb: SupabaseClient,
  channelId: string
): Promise<Pin[]> {
  return (
    await rows(
      sb
        .from('message_pins')
        .select(`*, message:internal_messages(${MESSAGE_COLUMNS})`)
        .eq('channel_id', channelId)
        .order('pinned_at', { ascending: false })
    )
  ).map(toPin);
}

/** The caller's saved messages in one channel (RLS returns only their own rows). */
export async function savedIdsIn(
  sb: SupabaseClient,
  channelId: string
): Promise<string[]> {
  return (
    await rows(
      sb
        .from('saved_messages')
        .select('message_id, message:internal_messages!inner(channel_id)')
        .eq('message.channel_id', channelId)
    )
  ).map((r) => String(r.message_id));
}

export async function attachmentsFor(
  sb: SupabaseClient,
  messageIds: string[]
): Promise<Record<string, ChatAttachment[]>> {
  if (messageIds.length === 0) return {};
  const data = await rows(
    sb
      .from('message_attachments')
      .select('id,message_id,storage_path,name,mime,bytes')
      .in('message_id', messageIds)
      .order('name')
  );
  const out: Record<string, ChatAttachment[]> = {};
  for (const r of data)
    (out[String(r.message_id)] ??= []).push(toAttachment(r));
  return out;
}

export async function channelMembers(
  sb: SupabaseClient,
  channelId: string
): Promise<ChannelMember[]> {
  return (
    await rows(
      sb
        .from('chat_channel_members')
        .select('*')
        .eq('channel_id', channelId)
        .order('joined_at')
    )
  ).map(toChannelMember);
}
