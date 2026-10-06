// ============================================================
// A thread's timeline: its messages with the conversation's notes
// (migration 061 — "sending number switched") placed between them, in
// order, grouped by day for the date separators.
//
// Pure, so the ordering rules are testable without a DOM.
// ============================================================

import { format } from 'date-fns';

import type { ConversationEvent, Message } from '@/types';

export type TimelineItem =
  | { kind: 'message'; message: Message }
  | { kind: 'event'; event: ConversationEvent };

export interface TimelineGroup {
  /** ISO timestamp of the group's first item — drives the separator label. */
  date: string;
  items: TimelineItem[];
}

/** Our side of the thread (an agent or the bot), as opposed to the customer's. */
export function isOutbound(message: Pick<Message, 'sender_type'>): boolean {
  return message.sender_type === 'agent' || message.sender_type === 'bot';
}

/**
 * Whether the item at `index` of a day group opens a run of messages
 * from one side: the bubble that gets WhatsApp's tail and the wider gap
 * above it, while the rest of the run stacks tight beneath. A note or
 * the start of the day breaks a run.
 */
export function startsMessageRun(
  items: readonly TimelineItem[],
  index: number
): boolean {
  const item = items[index];
  if (item?.kind !== 'message') return false;
  const prev = items[index - 1];
  return (
    prev?.kind !== 'message' ||
    isOutbound(prev.message) !== isOutbound(item.message)
  );
}

function itemTime(item: TimelineItem): number {
  return new Date(
    item.kind === 'message' ? item.message.created_at : item.event.created_at
  ).getTime();
}

/**
 * Merge `messages` (chronological, as the thread holds them) with the
 * conversation's `events` and group by local day.
 *
 * While older messages are still unloaded (`hasOlder`), a note dated
 * before the oldest loaded message is held back: shown now it would sit
 * at the top of the thread, above messages that actually precede it,
 * and jump once they load.
 *
 * Messages keep their given order; a note lands after every message
 * with the same or an earlier timestamp.
 */
export function buildTimelineGroups(
  messages: Message[],
  events: ConversationEvent[],
  hasOlder: boolean
): TimelineGroup[] {
  const oldestLoaded =
    hasOlder && messages.length > 0
      ? new Date(messages[0].created_at).getTime()
      : -Infinity;

  const notes = events
    .filter((e) => new Date(e.created_at).getTime() >= oldestLoaded)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  const items: TimelineItem[] = [];
  let n = 0;
  for (const message of messages) {
    const t = new Date(message.created_at).getTime();
    while (n < notes.length && new Date(notes[n].created_at).getTime() < t) {
      items.push({ kind: 'event', event: notes[n++] });
    }
    items.push({ kind: 'message', message });
  }
  while (n < notes.length) items.push({ kind: 'event', event: notes[n++] });

  const groups: TimelineGroup[] = [];
  let currentDay = '';
  for (const item of items) {
    const iso = new Date(itemTime(item)).toISOString();
    const day = format(new Date(iso), 'yyyy-MM-dd');
    if (day !== currentDay) {
      currentDay = day;
      groups.push({ date: iso, items: [item] });
    } else {
      groups[groups.length - 1].items.push(item);
    }
  }
  return groups;
}
