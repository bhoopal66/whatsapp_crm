/**
 * When an open channel or thread marks what it shows read. A mark covers
 * up to its newest shown message and no further: what came after was not
 * seen. Pure, so it tests without a DOM.
 */
import { timestampKey } from './message-list';

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
  // Only ever forward: `chat_mark_read` (087) stores what it is given, so
  // an older mark would bring back what a newer one had cleared. It is
  // also what marks an idle channel once, not on every list reload that
  // the mark's own echo causes.
  return key(i.at) > Math.max(key(i.held), key(i.sent));
}

/** Whether the member row has caught up with a mark that was sent. */
export const markLanded = (
  held: string | null | undefined,
  sent: string | null | undefined
): boolean => key(held) >= key(sent);
