// ============================================================
// When the open thread scrolls itself.
//
// Only to the bottom, and only when the chat is opened, on the person's
// own send, or when something arrived while they were already reading
// the newest messages. Anything else (a status tick, a reaction, an
// edit, an older page) leaves their place alone.
// ============================================================

import type { Message } from '@/types';
import { isOwnRow, isTempId } from './optimistic';

/** Within this many pixels of the end counts as reading the newest. */
export const NEAR_BOTTOM_PX = 120;

export function isNearBottom(gapPx: number): boolean {
  return gapPx <= NEAR_BOTTOM_PX;
}

/** How far the viewport's end is above the content's end. */
export function bottomGap(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** What the thread showed last; null before a chat's first messages. */
export interface ThreadSnapshot {
  conversationId: string;
  ids: ReadonlySet<string>;
}

export function threadSnapshot(
  conversationId: string,
  messages: readonly Pick<Message, 'id'>[]
): ThreadSnapshot {
  return { conversationId, ids: new Set(messages.map((m) => m.id)) };
}

export interface ThreadScroll {
  toBottom: boolean;
  /** Messages from someone else that arrived out of sight. */
  arrived: number;
}

/** `gapPx` is where the person last left the thread ({@link bottomGap}). */
export function threadScroll(
  prev: ThreadSnapshot | null,
  conversationId: string,
  messages: readonly Pick<Message, 'id' | 'sender_type' | 'sender_id'>[],
  gapPx: number,
  viewerId: string | null | undefined
): ThreadScroll {
  if (!prev || prev.conversationId !== conversationId) {
    return { toBottom: true, arrived: 0 };
  }
  let heldSeen = false;
  let ownSend = false;
  let added = 0;
  let arrived = 0;
  for (const m of messages) {
    if (prev.ids.has(m.id)) {
      heldSeen = true;
      continue;
    }
    if (isTempId(m.id)) ownSend = true;
    // Above everything held is an older page, not an arrival.
    if (!heldSeen) continue;
    added += 1;
    if (!isOwnRow(m, viewerId)) arrived += 1;
  }
  // Nothing held is left: the thread was replaced, there is no place.
  if (ownSend || !heldSeen) return { toBottom: true, arrived: 0 };
  if (added > 0 && isNearBottom(gapPx)) return { toBottom: true, arrived: 0 };
  return { toBottom: false, arrived };
}
