/**
 * Internal chat (migration 087): domain types and row → type mappers.
 * Rows arrive snake_case from PostgREST and realtime payloads; only this
 * file knows the column names. Timestamps stay ISO strings, as elsewhere.
 */

export type ChannelKind = 'team' | 'private' | 'dm' | 'deal_room';
export type ChannelRole = 'admin' | 'member' | 'guest';
export type AuthorKind = 'user' | 'system';
export type BroadcastKind = 'channel' | 'here';
export type ChatNotificationKind =
  'mention' | 'dm' | 'thread_reply' | 'broadcast';

export interface Channel {
  id: string;
  accountId: string;
  kind: ChannelKind;
  /** NULL for a DM. */
  name: string | null;
  topic: string | null;
  /** A DM's member set as opened (from dm_key, sorted); [] for other kinds. */
  dmMemberIds: string[];
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface ChannelMember {
  channelId: string;
  userId: string;
  role: ChannelRole;
  joinedAt: string;
  lastReadAt: string | null;
  muted: boolean;
}

export interface ChannelWithMembership extends Channel {
  /** The caller's own row; null for a team channel they have not joined. */
  membership: ChannelMember | null;
}

export interface ChatAttachment {
  id: string;
  messageId: string;
  storagePath: string;
  name: string;
  mime: string;
  bytes: number;
}

/** One element of chat_post_message(p_attachments). */
export interface AttachmentInput {
  storage_path: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  /** Who reacted, in reaction order. */
  userIds: string[];
}

export interface ThreadReplyRef {
  id: string;
  authorId: string | null;
  createdAt: string;
}

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: string | null;
  /** Up to 3 distinct reply authors, most recent first. */
  authorIds: string[];
  /** The replies counted (deleted ones are not), oldest first. Kept so events apply exactly. */
  replies: ThreadReplyRef[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  accountId: string;
  threadRootId: string | null;
  authorKind: AuthorKind;
  /** NULL for a system post. */
  authorId: string | null;
  /** '' once deleted, '[erased]' once erased. */
  body: string;
  meta: Record<string, unknown>;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  erasedAt: string | null;
  attachments: ChatAttachment[];
  reactions: ReactionSummary[];
  /** Top-level messages only; null when there are no replies (or not loaded). */
  thread: ThreadSummary | null;
}

export interface MessagePage {
  /** Oldest first. */
  messages: ChatMessage[];
  /** More older messages exist. */
  hasMore: boolean;
}

export interface Pin {
  channelId: string;
  messageId: string;
  pinnedBy: string;
  pinnedAt: string;
  message: ChatMessage | null;
}

export interface ChatTagRef {
  name: string;
  color: string;
}

/** shared_conversations.snapshot, frozen at share time (087). */
export interface SharedSnapshot {
  contactName: string | null;
  /** Masked: '+971 XXXXXXX12'. */
  phone: string | null;
  company: string | null;
  chatTag: ChatTagRef | null;
  owner: string | null;
  lastMessages: {
    senderType: string;
    contentText: string | null;
    createdAt: string;
  }[];
  takenAt: string | null;
}

export interface SharedCard {
  messageId: string;
  conversationId: string;
  snapshot: SharedSnapshot;
  /** The caller may open the conversation; the live fields are null otherwise. */
  canOpen: boolean;
  chatTag: ChatTagRef | null;
  status: string | null;
  lastMessageAt: string | null;
}

export interface ChatPerson {
  userId: string;
  fullName: string | null;
  avatarUrl: string | null;
  /** The account role (owner … viewer, bank_guest). */
  role: string;
  bankCode: string | null;
  presenceStatus: string | null;
  lastSeenAt: string | null;
}

export interface UnreadCount {
  channelId: string;
  unread: number;
  mentions: number;
}

export interface WorkspaceBadge {
  accountId: string;
  unread: number;
  mentions: number;
}

export interface SearchHit {
  messageId: string;
  channelId: string;
  threadRootId: string | null;
  authorId: string | null;
  body: string;
  createdAt: string;
  rank: number;
}

export interface ChatNotification {
  id: string;
  userId: string;
  accountId: string;
  messageId: string;
  kind: ChatNotificationKind;
  createdAt: string;
  readAt: string | null;
}

// ---------- mappers ----------

type Row = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === 'string' ? v : String(v ?? '');
const opt = (v: unknown): string | null => (v == null ? null : str(v));
const num = (v: unknown): number =>
  typeof v === 'number' ? v : Number(v ?? 0);
const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

export function toChannel(r: Row): Channel {
  const dmKey = opt(r.dm_key);
  return {
    id: str(r.id),
    accountId: str(r.account_id),
    kind: str(r.kind) as ChannelKind,
    name: opt(r.name),
    topic: opt(r.topic),
    dmMemberIds: dmKey ? dmKey.split(',').filter(Boolean) : [],
    createdBy: str(r.created_by),
    archivedAt: opt(r.archived_at),
    createdAt: str(r.created_at),
  };
}

export function toChannelMember(r: Row): ChannelMember {
  return {
    channelId: str(r.channel_id),
    userId: str(r.user_id),
    role: str(r.role) as ChannelRole,
    joinedAt: str(r.joined_at),
    lastReadAt: opt(r.last_read_at),
    muted: r.muted === true,
  };
}

export function toChatMessage(r: Row): ChatMessage {
  return {
    id: str(r.id),
    channelId: str(r.channel_id),
    accountId: str(r.account_id),
    threadRootId: opt(r.thread_root_id),
    authorKind: r.author_kind === 'system' ? 'system' : 'user',
    authorId: opt(r.author_id),
    body: str(r.body),
    meta: obj(r.meta),
    createdAt: str(r.created_at),
    editedAt: opt(r.edited_at),
    deletedAt: opt(r.deleted_at),
    erasedAt: opt(r.erased_at),
    attachments: [],
    reactions: [],
    thread: null,
  };
}

export function toAttachment(r: Row): ChatAttachment {
  return {
    id: str(r.id),
    messageId: str(r.message_id),
    storagePath: str(r.storage_path),
    name: str(r.name),
    mime: str(r.mime),
    bytes: num(r.bytes),
  };
}

function toTagRef(v: unknown): ChatTagRef | null {
  const t = obj(v);
  return typeof t.name === 'string'
    ? { name: t.name, color: str(t.color) }
    : null;
}

export function toSharedCard(r: Row): SharedCard {
  const s = obj(r.snapshot);
  return {
    messageId: str(r.message_id),
    conversationId: str(r.conversation_id),
    snapshot: {
      contactName: opt(s.contact_name),
      phone: opt(s.phone),
      company: opt(s.company),
      chatTag: toTagRef(s.chat_tag),
      owner: opt(s.owner),
      lastMessages: (Array.isArray(s.last_messages) ? s.last_messages : []).map(
        (m: unknown) => {
          const x = obj(m);
          return {
            senderType: str(x.sender_type),
            contentText: opt(x.content_text),
            createdAt: str(x.created_at),
          };
        }
      ),
      takenAt: opt(s.taken_at),
    },
    canOpen: r.can_open === true,
    chatTag: toTagRef(r.chat_tag),
    status: opt(r.status),
    lastMessageAt: opt(r.last_message_at),
  };
}

export function toChatPerson(r: Row): ChatPerson {
  return {
    userId: str(r.user_id),
    fullName: opt(r.full_name),
    avatarUrl: opt(r.avatar_url),
    role: str(r.role),
    bankCode: opt(r.bank_code),
    presenceStatus: opt(r.presence_status),
    lastSeenAt: opt(r.last_seen_at),
  };
}

export const toUnreadCount = (r: Row): UnreadCount => ({
  channelId: str(r.channel_id),
  unread: num(r.unread),
  mentions: num(r.mentions),
});

export const toWorkspaceBadge = (r: Row): WorkspaceBadge => ({
  accountId: str(r.account_id),
  unread: num(r.unread),
  mentions: num(r.mentions),
});

export const toSearchHit = (r: Row): SearchHit => ({
  messageId: str(r.message_id),
  channelId: str(r.channel_id),
  threadRootId: opt(r.thread_root_id),
  authorId: opt(r.author_id),
  body: str(r.body),
  createdAt: str(r.created_at),
  rank: num(r.rank),
});

export const toChatNotification = (r: Row): ChatNotification => ({
  id: str(r.id),
  userId: str(r.user_id),
  accountId: str(r.account_id),
  messageId: str(r.message_id),
  kind: str(r.kind) as ChatNotificationKind,
  createdAt: str(r.created_at),
  readAt: opt(r.read_at),
});

export function toPin(r: Row): Pin {
  return {
    channelId: str(r.channel_id),
    messageId: str(r.message_id),
    pinnedBy: str(r.pinned_by),
    pinnedAt: str(r.pinned_at),
    message: r.message ? toChatMessage(obj(r.message)) : null,
  };
}
