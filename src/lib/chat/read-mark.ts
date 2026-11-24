/**
 * When an open channel or thread marks what it shows read. A mark covers
 * up to its newest shown message and no further: what came after was not
 * seen. Pure, so it tests without a DOM.
 */
import { parseMentions } from './mentions';
import { timestampKey } from './message-list';
import type { ChatMessage, UnreadCount } from './types';

const key = (at: string | null | undefined) =>
  at ? timestampKey(at) : Number.NEGATIVE_INFINITY;

export function shouldMarkRead(i: {
  /** What is shown is whole: nothing is missing before its newest. */
  ready: boolean;
  /** The viewer has a member row (an unjoined team channel has none). */
  member: boolean;
  /** The tab is visible. */
  visible: boolean;
  /** The newest shown message's `createdAt`; null when there is none. */
  at: string | null;
  /** The member row's own read mark. */
  held: string | null | undefined;
  /** The last mark sent whose echo has not reached the member row. */
  sent: string | null | undefined;
}): boolean {
  if (!i.ready || !i.member || !i.visible || !i.at) return false;
  // Only ever forward, as `chat_mark_read` (307). It is also what marks an
  // idle channel once, not on every list reload that the mark's own echo
  // causes.
  return key(i.at) > Math.max(key(i.held), key(i.sent));
}

/** Whether the member row has caught up with a mark that was sent. */
export const markLanded = (
  held: string | null | undefined,
  sent: string | null | undefined
): boolean => key(held) >= key(sent);

/** A mention's message and when it was sent. */
export type SeenMention = Pick<ChatMessage, 'id' | 'createdAt'>;

const newer = (m: SeenMention, since: string | null) =>
  key(m.createdAt) > key(since);

/**
 * The replies that mention `me` and are newer than `since`, as
 * chat_unread_counts (087) counts them. A forwarded copy mentions nobody.
 */
export function unreadMentions(
  replies: readonly ChatMessage[],
  me: string | null | undefined,
  since: string | null
): SeenMention[] {
  if (!me) return [];
  return replies
    .filter(
      (m) =>
        m.authorId !== me &&
        !m.deletedAt &&
        !m.erasedAt &&
        !m.forwarded &&
        newer(m, since) &&
        parseMentions(m.body).userIds.includes(me.toLowerCase())
    )
    .map(({ id, createdAt }) => ({ id, createdAt }));
}

/**
 * The mentions seen at the end of a thread and not covered by the read
 * mark yet, per person and channel, in memory. The mark is the whole
 * channel's: with one unseen in another thread it cannot move, and
 * without this the two threads would wait for each other.
 */
const seenMentions = new Map<string, readonly SeenMention[]>();

/** `here`, and what was seen in the channel's other threads since `since`. */
export function withSeenMentions(
  seenKey: string,
  here: readonly SeenMention[],
  since: string | null
): readonly SeenMention[] {
  const other = (seenMentions.get(seenKey) ?? []).filter(
    (m) => newer(m, since) && !here.some((h) => h.id === m.id)
  );
  return [...other, ...here];
}

/** The end of a thread is on screen: `here` was seen. */
export function noteSeenMentions(
  seenKey: string,
  here: readonly SeenMention[],
  since: string | null
): void {
  seenMentions.set(seenKey, withSeenMentions(seenKey, here, since));
}

/**
 * Whether a thread may mark its channel read: the mark covers the
 * channel's own messages and its other threads' mentions too, so only
 * once nothing is unread but the `seen` mentions. An unknown count (not
 * read yet, not a member) is not zero.
 */
export function nothingElseUnread(
  unread:
    | readonly Pick<UnreadCount, 'channelId' | 'unread' | 'mentions'>[]
    | undefined,
  channelId: string,
  seen: readonly SeenMention[]
): boolean {
  const count = unread?.find((u) => u.channelId === channelId);
  return count?.unread === 0 && count.mentions <= seen.length;
}

/** Of a thread's newest reply and the seen mentions, the newest. */
export function newestSeen(
  at: string | null,
  seen: readonly SeenMention[]
): string | null {
  return seen.reduce<string | null>(
    (max, m) => (key(m.createdAt) > key(max) ? m.createdAt : max),
    at
  );
}
