/**
 * Which per-message actions the team-chat timeline offers, and the
 * small pure pieces behind them. The database decides (087): edit is
 * the author's, delete the author's or a workspace owner/admin's, and
 * reacting, pinning and editing need write access to the channel.
 */
import { mentionSegments } from './mentions';
import type { ChatMessage, ChatPerson } from './types';

export const QUICK_REACTIONS = ['👍', '✅', '👀', '🙏', '❤️', '😂'] as const;

export interface MessageActionSet {
  react: boolean;
  thread: boolean;
  edit: boolean;
  delete: boolean;
  pin: boolean;
  save: boolean;
  copy: boolean;
}

const NONE: MessageActionSet = {
  react: false,
  thread: false,
  edit: false,
  delete: false,
  pin: false,
  save: false,
  copy: false,
};

/**
 * A tombstone has no actions; a system post only reactions; a person's
 * post the rest, by the rules above. `threads` = the view can open a
 * thread (replies themselves cannot have one).
 */
export function messageActions(
  m: Pick<
    ChatMessage,
    'authorKind' | 'authorId' | 'deletedAt' | 'erasedAt' | 'threadRootId'
  >,
  i: {
    userId: string | null;
    workspaceAdmin: boolean;
    canWrite: boolean;
    threads: boolean;
  }
): MessageActionSet {
  if (m.deletedAt || m.erasedAt) return NONE;
  if (m.authorKind === 'system') return { ...NONE, react: i.canWrite };
  const own =
    !!i.userId && m.authorId?.toLowerCase() === i.userId.toLowerCase();
  return {
    react: i.canWrite,
    thread: i.threads && !m.threadRootId,
    edit: i.canWrite && own,
    delete: own || i.workspaceAdmin,
    pin: i.canWrite,
    save: true,
    copy: true,
  };
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
