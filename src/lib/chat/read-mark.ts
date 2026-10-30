/**
 * When an open channel marks itself read. A mark-read writes the viewer's
 * member row, which comes back by realtime and reloads the channel list,
 * so keying the mark on the membership object marked an idle, visible
 * channel every couple of seconds and reloaded every viewer's lists. A
 * mark is owed only for a newest message not yet marked (or the first
 * time a channel is opened). Pure, so it tests without a DOM.
 */

/** What the last mark covered. */
export interface ReadMark {
  channelId: string;
  /** The newest message shown when it was marked; null for an empty channel. */
  newestId: string | null;
}

export function shouldMarkRead(i: {
  channelId: string;
  /** The timeline's first page is still loading. */
  loading: boolean;
  /** The viewer has a member row (an unjoined team channel has none). */
  member: boolean;
  /** The tab is visible. */
  visible: boolean;
  newestId: string | null | undefined;
  last: ReadMark | null;
}): boolean {
  if (i.loading || !i.member || !i.visible) return false;
  const newestId = i.newestId ?? null;
  return !(
    i.last &&
    i.last.channelId === i.channelId &&
    i.last.newestId === newestId
  );
}
