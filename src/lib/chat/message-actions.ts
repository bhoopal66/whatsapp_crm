/**
 * Which per-message actions the team-chat timeline offers, and the
 * small pure pieces behind them. The database decides (087): edit is
 * the author's, delete the author's or a workspace owner/admin's, and
 * reacting, pinning and editing need write access to the channel.
 * Since 160 removing someone else's message is moderation (a workspace
 * owner/admin, or a channel admin of a team/private channel) and needs
 * a reason, so it is its own action.
 */
import { mentionSegments } from './mentions';
import { canModerate } from './moderation';
import { windowOpen, type ChatPermissions } from './permissions';
import type { ChatMessage, ChatPerson, MessageEdit } from './types';

/**
 * Agreed, done, looking at it, in progress, thank you, well done. This is
 * a company chat room, so the one-tap choices are work answers; anything
 * else is still in the full picker.
 */
export const QUICK_REACTIONS = ['👍', '✅', '👀', '⏳', '🙏', '👏'] as const;

export interface MessageActionSet {
  react: boolean;
  /** Quote this message in a reply (156). */
  quote: boolean;
  thread: boolean;
  edit: boolean;
  /** Delete one's own message (no reason). */
  delete: boolean;
  /** Remove someone else's message, with a reason (160). */
  moderate: boolean;
  pin: boolean;
  save: boolean;
  copy: boolean;
  /** Forward a copy to other channels or DMs (156). */
  forward: boolean;
}

const NONE: MessageActionSet = {
  react: false,
  quote: false,
  thread: false,
  edit: false,
  delete: false,
  moderate: false,
  pin: false,
  save: false,
  copy: false,
  forward: false,
};

/**
 * A tombstone has no actions; a system post only reactions, a quote
 * reply and Forward; a person's post the rest, by the rules above and
 * the role permissions and time windows of 157 (UX only: the RPCs
 * re-check them). `threads` = the view can open a
 * thread (replies themselves cannot have one).
 */
export function messageActions(
  m: Pick<
    ChatMessage,
    | 'authorKind'
    | 'authorId'
    | 'deletedAt'
    | 'erasedAt'
    | 'threadRootId'
    | 'createdAt'
    | 'attachments'
  >,
  i: {
    userId: string | null;
    workspaceAdmin: boolean;
    /** A channel admin of this team/private channel (isChannelModerator). */
    channelAdmin?: boolean;
    canWrite: boolean;
    threads: boolean;
    /**
     * The viewer's chat permissions (157): pin_messages, forward_messages
     * (with upload_files or send_voice for a message with files),
     * edit_own, delete_own and the edit/delete windows. Moderation is
     * not affected.
     */
    permissions: Pick<
      ChatPermissions,
      'can' | 'editWindowMinutes' | 'deleteWindowMinutes' | 'windowsApply'
    >;
    /** Evaluated at render: a window that closes shows on the next one. */
    now: number;
  }
): MessageActionSet {
  const p = i.permissions;
  const inWindow = (minutes: number | null) =>
    !p.windowsApply || windowOpen(m.createdAt, minutes, i.now);
  if (m.deletedAt || m.erasedAt) return NONE;
  // A forward copies each file through storage first, and the storage
  // INSERT policy (chat_storage_can_write) needs upload_files or
  // send_voice: without either, a message with files cannot be
  // forwarded, though text alone can.
  const forward =
    p.can.forward_messages &&
    (m.attachments.length === 0 || p.can.upload_files || p.can.send_voice);
  const moderate = canModerate(m, {
    userId: i.userId,
    workspaceAdmin: i.workspaceAdmin,
    channelAdmin: !!i.channelAdmin,
  });
  if (m.authorKind === 'system')
    return {
      ...NONE,
      react: i.canWrite,
      quote: i.canWrite,
      forward,
      moderate,
    };
  const own =
    !!i.userId && m.authorId?.toLowerCase() === i.userId.toLowerCase();
  return {
    react: i.canWrite,
    quote: i.canWrite,
    thread: i.threads && !m.threadRootId,
    edit: i.canWrite && own && p.can.edit_own && inWindow(p.editWindowMinutes),
    delete: own && p.can.delete_own && inWindow(p.deleteWindowMinutes),
    moderate,
    pin: i.canWrite && p.can.pin_messages,
    save: true,
    copy: true,
    // Posts into the targets, not here: write access here is not needed.
    forward,
  };
}

/**
 * "View edit history" on an edited person's post that still stands.
 * internal_message_edits (087) is readable only by a workspace
 * owner/admin, and only on channels they read directly, which are the
 * ones the timeline shows them; anyone else would get an empty list.
 */
export function canViewEditHistory(
  m: Pick<ChatMessage, 'authorKind' | 'editedAt' | 'deletedAt' | 'erasedAt'>,
  workspaceAdmin: boolean
): boolean {
  return (
    workspaceAdmin &&
    m.authorKind !== 'system' &&
    !!m.editedAt &&
    !m.deletedAt &&
    !m.erasedAt
  );
}

export interface EditHistoryRow {
  id: string;
  /** The earlier body as people read it (mentions as "@Name"). */
  body: string;
  editedAt: string;
  editorName: string;
}

/** The earlier versions, newest first, each with who replaced it. */
export function editHistoryRows(
  edits: readonly MessageEdit[],
  people: ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>,
  unknownName: string
): EditHistoryRow[] {
  const name = (id: string) =>
    people
      .find((p) => p.userId.toLowerCase() === id.toLowerCase())
      ?.fullName?.trim() || unknownName;
  return [...edits]
    .sort(
      (a, b) =>
        (Date.parse(b.editedAt) || 0) - (Date.parse(a.editedAt) || 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )
    .map((e) => ({
      id: e.id,
      body: plainText(e.previousBody, people, unknownName),
      editedAt: e.editedAt,
      editorName: name(e.editedBy),
    }));
}

/** The body as people read it (mentions as "@Name"), for the clipboard. */
export function plainText(
  body: string,
  people: ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>,
  unknownName: string
): string {
  return mentionSegments(body, people)
    .map((s) =>
      s.type === 'text'
        ? s.text
        : s.type === 'mention'
          ? `@${s.name ?? unknownName}`
          : `@${s.kind}`
    )
    .join('');
}

/**
 * A change made here, shown until the realtime echo arrives: it applies
 * only while the message is still the version it was made against, so
 * any later server state (the echo, or someone else's change) wins.
 */
export interface LocalPatch {
  base: string;
  patch: Partial<Pick<ChatMessage, 'body' | 'editedAt' | 'deletedAt'>>;
}

export const messageVersion = (
  m: Pick<ChatMessage, 'body' | 'editedAt' | 'deletedAt' | 'erasedAt'>
): string =>
  [m.editedAt ?? '', m.deletedAt ?? '', m.erasedAt ?? '', m.body].join('|');

export function localPatch(
  m: ChatMessage,
  patch: LocalPatch['patch']
): LocalPatch {
  return { base: messageVersion(m), patch };
}

export function applyLocalPatch(
  m: ChatMessage,
  p: LocalPatch | null
): ChatMessage {
  if (!p || p.base !== messageVersion(m)) return m;
  const next = { ...m, ...p.patch };
  return p.patch.deletedAt ? { ...next, body: '', attachments: [] } : next;
}
