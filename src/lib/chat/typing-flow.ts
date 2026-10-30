/**
 * Typing indicators, the moving parts (156): when the composer tells the
 * channel it is typing or has stopped, and how the typers' rows held by
 * one open channel follow the realtime changes. Pure; the rules over a
 * row's age are typing.ts's.
 */
import { shouldSendTyping, TYPING_TTL_MS } from './typing';
import type { TypingRow } from './types';

/**
 * What a draft change should tell the channel. `lastSentAt` is when the
 * last "typing" went out, null when none is live (never sent, or stopped
 * since). A stop goes out only after a start, and a start never while
 * the composer is blocked (the database would refuse it anyway).
 */
export function typingStep(o: {
  prevText: string;
  nextText: string;
  lastSentAt: number | null;
  now: number;
  blocked: boolean;
}): 'start' | 'stop' | null {
  const live = o.lastSentAt !== null;
  if (o.blocked || !o.nextText.trim()) return live ? 'stop' : null;
  // A change that leaves the text alone (a mention's bookkeeping) is not typing.
  if (o.nextText === o.prevText) return null;
  return shouldSendTyping(o.lastSentAt, o.now) ? 'start' : null;
}

/** A realtime chat_typing change; a DELETE carries only the key. */
export interface TypingChange {
  type: 'insert' | 'update' | 'delete';
  row: TypingRow | Pick<TypingRow, 'channelId' | 'userId'>;
}

/**
 * The open channel's rows after one realtime change: one row per person
 * (the table's key is channel + user). A live row is stamped with
 * `receivedAt`, the viewer's own clock, so a skewed clock between the
 * browser and the database never hides or pins a typer: the change
 * arriving is itself the heartbeat.
 */
export function applyTypingChange(
  rows: readonly TypingRow[],
  change: TypingChange,
  channelId: string,
  receivedAt: number
): readonly TypingRow[] {
  const { row } = change;
  if (row.channelId !== channelId) return rows;
  const others = rows.filter((r) => r.userId !== row.userId);
  if (change.type === 'delete' || !('at' in row)) {
    return others.length === rows.length ? rows : others;
  }
  return [...others, { ...row, at: new Date(receivedAt).toISOString() }];
}

/**
 * The rows read when the channel opened, under any live row that has
 * already arrived for the same person (it is newer).
 */
export function mergeTypingRead(
  live: readonly TypingRow[],
  read: readonly TypingRow[],
  channelId: string
): readonly TypingRow[] {
  const held = new Set(live.map((r) => r.userId));
  const fresh = read.filter(
    (r) => r.channelId === channelId && !held.has(r.userId)
  );
  return fresh.length ? [...live, ...fresh] : live;
}

/** Drops rows past the TTL (same reference when nothing went). */
export function pruneTyping(
  rows: readonly TypingRow[],
  now: number
): readonly TypingRow[] {
  const kept = rows.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && now - t <= TYPING_TTL_MS;
  });
  return kept.length === rows.length ? rows : kept;
}
