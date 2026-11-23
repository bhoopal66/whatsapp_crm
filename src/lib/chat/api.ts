/**
 * Typed wrappers over the chat RPCs and tables of migration 087 (and
 * 091's channel administration). The
 * browser calls them with the user's session: every RPC is SECURITY
 * DEFINER and re-checks the caller, RLS limits every read, so there is
 * no API route in between. Every failure is thrown as a ChatError.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ChatError,
  toChatError,
  type ChatErrorCode,
  type ChatErrorKey,
} from './errors';
import { isUuid } from './mentions';
import { CHAT_FILES_BUCKET, chatFilePath, storageUploadError } from './uploads';
import {
  toAttachment,
  toChannel,
  toChannelMember,
  toChannelRestriction,
  toChatMessage,
  toChatPerson,
  toChannelFile,
  toTypingRow,
  toVoicePlay,
  toMessageEdit,
  toPin,
  toSearchHit,
  toSharedCard,
  toSharedCallCard,
  toUnreadCount,
  toWorkspaceBadge,
  type AttachmentInput,
  type AttachmentKind,
  type AuthorKind,
  type ChannelKind,
  type ChannelFile,
  type ChannelMember,
  type ChannelRestriction,
  type ChannelWithMembership,
  type ChatAttachment,
  type ChatMessage,
  type ChatPerson,
  type MessageEdit,
  type MessagePage,
  type Pin,
  type ReactionSummary,
  type SearchHit,
  type SharedCard,
  type SharedCallCard,
  type ThreadSummary,
  type TypingRow,
  type VoicePlay,
  type UnreadCount,
  type WorkspaceBadge,
} from './types';
import { summarizeReplies } from './message-list';
import { rulesFromRows, rowsToSave, type DmMatrix } from './dm-rules';
import {
  deniedFromMatrix,
  matrixFromRows,
  parseMyPermissions,
  type ChannelRule,
  type ChatPermissions,
  type DeniedPair,
  type SensitiveGuard,
} from './permissions';

type Row = Record<string, unknown>;

/** internal_messages without the generated `search` tsvector. */
export const MESSAGE_COLUMNS =
  'id,channel_id,account_id,thread_root_id,author_kind,author_id,body,meta,created_at,edited_at,deleted_at,deleted_by,erased_at,reply_to_id';

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

export async function postMessage(
  sb: SupabaseClient,
  i: {
    channelId: string;
    body: string;
    threadRootId?: string | null;
    shareConversationId?: string | null;
    attachments?: AttachmentInput[];
    /** 156: the message this one quotes. */
    replyToId?: string | null;
    /** 276: names this post; a repeat of it is answered with the first message. */
    clientId?: string;
  }
): Promise<string> {
  const args: Row = {
    p_channel: i.channelId,
    p_body: i.body,
    p_thread_root: i.threadRootId ?? null,
    p_share_conversation: i.shareConversationId ?? null,
    p_attachments: i.attachments ?? [],
    // Sent only when set: a database still on 087-155 has no p_reply_to
    // and would reject the named argument, so ordinary posts must not carry it.
    ...(i.replyToId ? { p_reply_to: i.replyToId } : {}),
  };
  if (!i.clientId) return rpc(sb, 'chat_post_message', args);
  try {
    return await rpc(sb, 'chat_post_message', {
      ...args,
      p_client_id: i.clientId,
    });
  } catch (err) {
    // No function with that argument (a database before 276): nothing ran.
    if ((err as ChatError).sqlState !== 'PGRST202') throw err;
    return rpc(sb, 'chat_post_message', args);
  }
}

/**
 * Forwards a message into another channel (156). The server copies body
 * and meta; the files are copied here, into the TARGET channel's storage
 * prefix, because the storage policies and the path checks are per
 * channel. A failed copy throws before the RPC, so nothing posts.
 */
export async function forwardMessage(
  sb: SupabaseClient,
  i: {
    accountId: string;
    messageId: string;
    targetChannelId: string;
    attachments: ChatAttachment[];
  }
): Promise<string> {
  const copies = await Promise.all(
    i.attachments.map(async (a): Promise<AttachmentInput> => {
      const to = chatFilePath(i.accountId, i.targetChannelId, a.name);
      const { error } = await sb.storage
        .from(CHAT_FILES_BUCKET)
        .copy(a.storagePath, to);
      if (error) throw storageUploadError(error);
      return {
        storage_path: to,
        name: a.name,
        mime: a.mime,
        bytes: a.bytes,
        kind: a.kind,
        ...(a.kind === 'voice' && a.durationMs != null
          ? { duration_ms: a.durationMs }
          : {}),
      };
    })
  );
  return rpc(sb, 'chat_forward_message', {
    p_message: i.messageId,
    p_channel: i.targetChannelId,
    p_attachments: copies,
  });
}

/** Tells the channel (or one thread) the caller is typing, or has stopped (156). */
export const setTyping = (
  sb: SupabaseClient,
  i: { channelId: string; threadRootId?: string | null; typing: boolean }
): Promise<void> =>
  rpc(sb, 'chat_set_typing', {
    p_channel: i.channelId,
    p_thread_root: i.threadRootId ?? null,
    p_typing: i.typing,
  });

/** Who is typing in a channel right now (rows may be stale; see typing.ts). */
export async function typingIn(
  sb: SupabaseClient,
  channelId: string
): Promise<TypingRow[]> {
  return (
    await rows(
      sb
        .from('chat_typing')
        .select('channel_id,account_id,user_id,thread_root_id,at,stopped')
        .eq('channel_id', channelId)
    )
  ).map(toTypingRow);
}

export const markVoicePlayed = (
  sb: SupabaseClient,
  messageId: string
): Promise<void> => rpc(sb, 'chat_mark_voice_played', { p_message: messageId });

export async function voicePlaysFor(
  sb: SupabaseClient,
  messageIds: string[]
): Promise<Record<string, VoicePlay[]>> {
  if (messageIds.length === 0) return {};
  const data = await rows(
    sb
      .from('chat_voice_plays')
      .select('message_id,user_id,played_at')
      .in('message_id', messageIds)
      .order('played_at')
  );
  const out: Record<string, VoicePlay[]> = {};
  for (const r of data) (out[String(r.message_id)] ??= []).push(toVoicePlay(r));
  return out;
}

/** Messages by id, attachments filled; for quotes outside the loaded page. RLS drops what the caller cannot read. */
export async function messagesByIds(
  sb: SupabaseClient,
  ids: string[]
): Promise<ChatMessage[]> {
  if (ids.length === 0) return [];
  const msgs = (
    await rows(
      sb.from('internal_messages').select(MESSAGE_COLUMNS).in('id', ids)
    )
  ).map(toChatMessage);
  const atts = await attachmentsFor(
    sb,
    msgs.map((m) => m.id)
  );
  return msgs.map((m) => ({ ...m, attachments: atts[m.id] ?? [] }));
}

/** A channel's files, newest first (156); `kind` filters voice/image/video/file. */
export async function channelFiles(
  sb: SupabaseClient,
  i: {
    channelId: string;
    kind?: 'voice' | 'image' | 'video' | 'file' | null;
    before?: string | null;
    limit?: number;
  }
): Promise<{ items: ChannelFile[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(i.limit ?? 60), 1), 200);
  const data = await rpc<Row[] | null>(sb, 'chat_channel_files', {
    p_channel: i.channelId,
    p_kind: i.kind ?? null,
    p_before: i.before ?? null,
    p_limit: limit + 1,
  });
  const list = data ?? [];
  return {
    items: list.slice(0, limit).map(toChannelFile),
    hasMore: list.length > limit,
  };
}

/**
 * Posts a card of a phone call (103). The body is the sharer's comment
 * and must carry no call detail: every reader of the channel sees it,
 * while the card's details reach only people who may see the call.
 */
export const shareCall = (
  sb: SupabaseClient,
  i: { channelId: string; callId: string; body: string }
): Promise<string> =>
  rpc(sb, 'chat_share_call', {
    p_channel: i.channelId,
    p_call: i.callId,
    p_body: i.body,
  });

export const editMessage = (
  sb: SupabaseClient,
  i: { messageId: string; body: string }
): Promise<void> =>
  rpc(sb, 'chat_edit_message', { p_message: i.messageId, p_body: i.body });

/**
 * Soft delete; returns the storage paths of the attachments it dropped.
 * For POST /api/chat/messages/[id]/delete, on the caller's session: the
 * browser calls deleteMessageAndFiles, because only that route can also
 * remove the files (chat-files has no client DELETE policy).
 */
export const deleteMessage = async (
  sb: SupabaseClient,
  messageId: string,
  reason?: string
): Promise<string[]> =>
  (await rpc<string[] | null>(sb, 'chat_delete_message', {
    p_message: messageId,
    ...(reason ? { p_reason: reason } : {}),
  })) ?? [];

const DELETE_ERROR_BY_STATUS: Record<number, [ChatErrorCode, ChatErrorKey]> = {
  400: ['INVALID', 'invalid'],
  403: ['FORBIDDEN', 'forbidden'],
  404: ['NOT_FOUND', 'notFound'],
  409: ['CONFLICT', 'conflict'],
};

/** Deletes a message and its files through the server route; throws a ChatError. */
export async function deleteMessageAndFiles(
  messageId: string,
  fetchImpl: typeof fetch = fetch,
  reason?: string
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(
      `/api/chat/messages/${encodeURIComponent(messageId)}/delete`,
      reason
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          }
        : { method: 'POST' }
    );
  } catch (err) {
    throw toChatError(err);
  }
  if (res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    error?: unknown;
    key?: unknown;
  } | null;
  const [code, coarse] = DELETE_ERROR_BY_STATUS[res.status] ?? [
    'UNKNOWN',
    'unknown',
  ];
  throw new ChatError(
    code,
    typeof json?.key === 'string' ? (json.key as ChatErrorKey) : coarse,
    typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`
  );
}

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

export const sharedCallCards = async (
  sb: SupabaseClient,
  messageIds: string[]
): Promise<SharedCallCard[]> =>
  messageIds.length === 0
    ? []
    : (
        (await rpc<Row[] | null>(sb, 'chat_shared_call_cards', {
          p_message_ids: messageIds,
        })) ?? []
      ).map(toSharedCallCard);

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

/**
 * Rename and/or re-topic a team or private channel (091). An omitted or
 * null field is kept; `topic: ''` clears the topic. A name another live
 * channel has is CONFLICT / duplicateName.
 */
export const updateChannel = (
  sb: SupabaseClient,
  i: { channelId: string; name?: string | null; topic?: string | null }
): Promise<void> =>
  rpc(sb, 'chat_update_channel', {
    p_channel: i.channelId,
    p_name: i.name ?? null,
    p_topic: i.topic ?? null,
  });

/**
 * Archive (true) or unarchive (false) a team or private channel (091).
 * Unarchiving after a live channel took the name is CONFLICT /
 * duplicateName: that channel has to be renamed first.
 */
export const setChannelArchived = (
  sb: SupabaseClient,
  channelId: string,
  archived: boolean
): Promise<void> =>
  rpc(sb, 'chat_archive_channel', {
    p_channel: channelId,
    p_archived: archived,
  });

/**
 * May the caller delete this channel (172)? The only answer to who sees
 * the action. Any failure is a no, without an error: the screen ships
 * before the migration, and until then the function is simply missing.
 */
export const canDeleteChannel = async (
  sb: SupabaseClient,
  channelId: string
): Promise<boolean> => {
  try {
    const { data, error } = await sb.rpc('chat_can_delete_channel', {
      p_channel: channelId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
};

/**
 * Delete a team or private channel for good, with everything in it (172).
 * `confirmName` must equal the channel's name exactly.
 */
export const deleteChannel = (
  sb: SupabaseClient,
  i: { channelId: string; confirmName: string }
): Promise<void> =>
  rpc(sb, 'chat_delete_channel', {
    p_channel: i.channelId,
    p_confirm_name: i.confirmName,
  });

/** Remove someone else from a team or private channel (091); leaving is leaveChannel. */
export const removeMember = (
  sb: SupabaseClient,
  i: { channelId: string; userId: string }
): Promise<void> =>
  rpc(sb, 'chat_remove_member', { p_channel: i.channelId, p_user: i.userId });

/** The caller's own mute switch, on any channel they belong to (091). */
export const setMuted = (
  sb: SupabaseClient,
  channelId: string,
  muted: boolean
): Promise<void> =>
  rpc(sb, 'chat_set_muted', { p_channel: channelId, p_muted: muted });

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

/**
 * Which of these channels have a bank guest among their members
 * (chat_channels_with_guests, migration 102; only channels the caller
 * can see are answered). Sharing customer details there is refused, so
 * the share pickers leave them out.
 */
export async function channelsWithGuests(
  sb: SupabaseClient,
  ids: readonly string[]
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const data = await rpc<unknown>(sb, 'chat_channels_with_guests', {
    p_channels: ids,
  });
  return new Set(
    Array.isArray(data) ? data.filter((v) => typeof v === 'string') : []
  );
}

/**
 * Replaces the workspace's DM rules (migration 143; owner/admin). The
 * whole set is sent: a pair left out reverts to 'all'.
 */
export const setDmRules = (
  sb: SupabaseClient,
  i: { accountId: string; rules: DmMatrix }
): Promise<void> =>
  rpc(sb, 'chat_set_dm_rules', {
    p_ws: i.accountId,
    p_rules: rowsToSave(i.rules),
  });

/** Whom the caller may open a DM with under the workspace's rules (143). */
export const dmPeers = async (
  sb: SupabaseClient,
  accountId: string
): Promise<string[]> => {
  const data = await rpc<unknown>(sb, 'chat_dm_peers', { p_ws: accountId });
  return Array.isArray(data)
    ? data.filter((v): v is string => typeof v === 'string')
    : [];
};

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

/**
 * A message's earlier versions, newest first. RLS (087) returns rows only
 * to a workspace owner/admin, on channels they can read directly.
 */
export async function messageEdits(
  sb: SupabaseClient,
  messageId: string
): Promise<MessageEdit[]> {
  return (
    await rows(
      sb
        .from('internal_message_edits')
        .select('id,message_id,previous_body,edited_at,edited_by')
        .eq('message_id', messageId)
        .order('edited_at', { ascending: false })
        .order('id', { ascending: false })
    )
  ).map(toMessageEdit);
}

export async function attachmentsFor(
  sb: SupabaseClient,
  messageIds: string[]
): Promise<Record<string, ChatAttachment[]>> {
  if (messageIds.length === 0) return {};
  const data = await rows(
    sb
      .from('message_attachments')
      .select('id,message_id,storage_path,name,mime,bytes,kind,duration_ms')
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

/** The workspace's DM rules as the full matrix; owner/admin read them (143's RLS). */
export async function getDmRules(
  sb: SupabaseClient,
  accountId: string
): Promise<DmMatrix> {
  const data = await rows(
    sb
      .from('chat_dm_rules')
      .select('class_a,class_b,scope')
      .eq('account_id', accountId)
  );
  return rulesFromRows(
    data.map((r) => ({
      class_a: String(r.class_a),
      class_b: String(r.class_b),
      scope: String(r.scope),
    }))
  );
}

// ---------- 157 role permissions and posting rules, 158 sensitive guard ----------

let myPermissionsErrorLogged = false;

/**
 * The caller's chat permissions in a workspace (chat_my_permissions).
 * Never throws: an error (an older database, a blip) answers ALL_ALLOWED
 * and is logged once, since the database re-checks every action anyway.
 */
export async function myPermissions(
  sb: SupabaseClient,
  accountId: string
): Promise<ChatPermissions> {
  try {
    return parseMyPermissions(
      await rpc<unknown>(sb, 'chat_my_permissions', { p_ws: accountId })
    );
  } catch (err) {
    if (!myPermissionsErrorLogged) {
      myPermissionsErrorLogged = true;
      console.error('[chat] chat_my_permissions failed', err);
    }
    return parseMyPermissions(null);
  }
}

/** Replaces the workspace's whole denied set (owner/admin). */
export const setPermissions = (
  sb: SupabaseClient,
  accountId: string,
  denied: readonly DeniedPair[]
): Promise<void> =>
  rpc(sb, 'chat_set_permissions', { p_ws: accountId, p_denied: denied });

/** The workspace's chat_role_permissions rows (each one a denial). */
export async function rolePermissionRows(
  sb: SupabaseClient,
  accountId: string
): Promise<DeniedPair[]> {
  const list = await rows(
    sb
      .from('chat_role_permissions')
      .select('role_class,capability')
      .eq('account_id', accountId)
  );
  return deniedFromMatrix(matrixFromRows(list));
}

export interface WorkspaceChatSettings {
  editWindowMinutes: number | null;
  deleteWindowMinutes: number | null;
  sensitive: SensitiveGuard;
}

/** The workspace's chat_workspace_settings row; defaults when there is none. */
export async function workspaceChatSettings(
  sb: SupabaseClient,
  accountId: string
): Promise<WorkspaceChatSettings> {
  const [r] = await rows(
    sb
      .from('chat_workspace_settings')
      .select('*')
      .eq('account_id', accountId)
      .limit(1)
  );
  const p = parseMyPermissions({
    edit_window_minutes: r?.edit_window_minutes,
    delete_window_minutes: r?.delete_window_minutes,
    sensitive: { mode: r?.sensitive_mode, scope: r?.sensitive_scope },
  });
  return {
    editWindowMinutes: p.editWindowMinutes,
    deleteWindowMinutes: p.deleteWindowMinutes,
    sensitive: p.sensitive,
  };
}

/** Edit / delete windows, 1..10080 minutes or null for no limit (owner/admin). */
export const setWorkspaceChatSettings = (
  sb: SupabaseClient,
  accountId: string,
  i: { editWindowMinutes: number | null; deleteWindowMinutes: number | null }
): Promise<void> =>
  rpc(sb, 'chat_set_workspace_settings', {
    p_ws: accountId,
    p_edit_window_minutes: i.editWindowMinutes,
    p_delete_window_minutes: i.deleteWindowMinutes,
  });

/** A team or private channel's rules; an omitted rule is kept. */
export const setChannelPolicy = (
  sb: SupabaseClient,
  channelId: string,
  i: {
    posting?: ChannelRule;
    threadReplies?: ChannelRule;
    mentionEveryone?: ChannelRule;
  }
): Promise<void> =>
  rpc(sb, 'chat_set_channel_policy', {
    p_channel: channelId,
    p_posting: i.posting ?? null,
    p_thread_replies: i.threadReplies ?? null,
    p_mention_everyone: i.mentionEveryone ?? null,
  });

/** 158's guard: off / warn / block, for channels with guests or all chat. */
export const setSensitiveGuard = (
  sb: SupabaseClient,
  accountId: string,
  i: SensitiveGuard
): Promise<void> =>
  rpc(sb, 'chat_set_sensitive_guard', {
    p_ws: accountId,
    p_mode: i.mode,
    p_scope: i.scope,
  });

// ---------- 159 audience and 160 moderation ----------

/** 159: who a team channel is open to; replaces the previous settings. */
export const setChannelAudience = (
  sb: SupabaseClient,
  channelId: string,
  i: { minRole: string | null; teamIds: string[] | null }
): Promise<void> =>
  rpc(sb, 'chat_set_channel_audience', {
    p_channel: channelId,
    p_min_role: i.minRole,
    p_team_ids: i.teamIds && i.teamIds.length > 0 ? i.teamIds : null,
  });

/** 159: the teams a team channel is restricted to ([] = no team restriction). */
export async function channelTeams(
  sb: SupabaseClient,
  channelId: string
): Promise<string[]> {
  return (
    await rows(
      sb
        .from('chat_channel_teams')
        .select('team_id')
        .eq('channel_id', channelId)
    )
  ).map((r) => String(r.team_id));
}

/**
 * 160: a channel's posting timeouts, lifted ones included (a lift sets
 * `until` to now; activeRestrictions picks the ones in force). RLS
 * decides the rows: the caller's own, or all when they can manage it.
 */
export async function channelRestrictions(
  sb: SupabaseClient,
  channelId: string
): Promise<ChannelRestriction[]> {
  return (
    await rows(
      sb
        .from('chat_channel_restrictions')
        .select('channel_id,user_id,until,reason,set_by,set_at')
        .eq('channel_id', channelId)
    )
  ).map(toChannelRestriction);
}

/** 160: block a member from posting until `until`; null clears the block. */
export const restrictMember = (
  sb: SupabaseClient,
  i: {
    channelId: string;
    userId: string;
    until: string | null;
    reason?: string;
  }
): Promise<void> =>
  rpc(sb, 'chat_restrict_member', {
    p_channel: i.channelId,
    p_user: i.userId,
    p_until: i.until,
    p_reason: i.reason ?? null,
  });

export interface ChannelExportAttachment {
  name: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  durationMs: number | null;
}

export interface ChannelExportMessage {
  id: string;
  threadRootId: string | null;
  replyToId: string | null;
  authorKind: AuthorKind;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  erasedAt: string | null;
  attachments: ChannelExportAttachment[];
}

export interface ChannelExport {
  channel: {
    id: string;
    kind: ChannelKind;
    name: string | null;
    topic: string | null;
  };
  messages: ChannelExportMessage[];
  /** The database stopped at its row cap; narrow the range for the rest. */
  truncated: boolean;
}

/** Tolerant parse of chat_export_channel's jsonb. */
export function parseChannelExport(raw: unknown): ChannelExport {
  const o = (v: unknown): Row =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
  const s = (v: unknown): string | null => (v == null ? null : String(v));
  const top = o(raw);
  const ch = o(top.channel);
  const list = Array.isArray(top.messages) ? (top.messages as unknown[]) : [];
  return {
    channel: {
      id: s(ch.id) ?? '',
      kind: (s(ch.kind) ?? 'team') as ChannelKind,
      name: s(ch.name),
      topic: s(ch.topic),
    },
    messages: list.map((m) => {
      const r = o(m);
      const atts = Array.isArray(r.attachments)
        ? (r.attachments as unknown[])
        : [];
      return {
        id: s(r.id) ?? '',
        threadRootId: s(r.thread_root_id),
        replyToId: s(r.reply_to_id),
        authorKind: r.author_kind === 'system' ? 'system' : 'user',
        authorId: s(r.author_id),
        authorName: s(r.author_name),
        body: s(r.body) ?? '',
        createdAt: s(r.created_at) ?? '',
        editedAt: s(r.edited_at),
        deletedAt: s(r.deleted_at),
        deletedBy: s(r.deleted_by),
        erasedAt: s(r.erased_at),
        attachments: atts.map((a) => {
          const x = o(a);
          return {
            name: s(x.name) ?? '',
            mime: s(x.mime) ?? '',
            bytes: Number(x.bytes ?? 0) || 0,
            kind: x.kind === 'voice' ? 'voice' : 'file',
            durationMs: x.duration_ms == null ? null : Number(x.duration_ms),
          };
        }),
      };
    }),
    truncated: top.truncated === true,
  };
}

/** 160: an owner/admin's audited export of a channel (the reason is logged). */
export async function exportChannel(
  sb: SupabaseClient,
  i: { channelId: string; from?: string; to?: string; reason: string }
): Promise<ChannelExport> {
  return parseChannelExport(
    await rpc<unknown>(sb, 'chat_export_channel', {
      p_channel: i.channelId,
      p_from: i.from ?? null,
      p_to: i.to ?? null,
      p_reason: i.reason,
    })
  );
}
