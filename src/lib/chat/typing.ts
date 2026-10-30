/**
 * Typing indicators (156): pure rules over chat_typing rows. A row is a
 * heartbeat, never a fact: it counts only while younger than the TTL, so
 * a closed tab (no stop call) fades by itself. A stop marks the row
 * `stopped` (never a delete, whose realtime event is not RLS-filtered).
 */
import type { TypingRow } from './types';

export const TYPING_TTL_MS = 6000;
export const TYPING_SEND_INTERVAL_MS = 3000;

/**
 * User ids typing in `channelId` within the given scope (`threadRootId`
 * null = the main timeline), most recent first, never `selfId`.
 */
export function activeTypers(
  rows: readonly TypingRow[],
  o: {
    channelId: string;
    threadRootId: string | null;
    selfId: string;
    now: number;
  }
): string[] {
  const seen = new Set<string>();
  return rows
    .map((r) => ({ r, t: Date.parse(r.at) }))
    .filter(
      ({ r, t }) =>
        r.channelId === o.channelId &&
        r.threadRootId === o.threadRootId &&
        r.userId !== o.selfId &&
        !r.stopped &&
        Number.isFinite(t) &&
        o.now - t <= TYPING_TTL_MS
    )
    .sort((a, b) => b.t - a.t)
    .map(({ r }) => r.userId)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/** Send a heartbeat on the first keystroke, then at most every interval. */
export function shouldSendTyping(
  lastSentAt: number | null,
  now: number
): boolean {
  return lastSentAt === null || now - lastSentAt >= TYPING_SEND_INTERVAL_MS;
}

/** one: "A is typing"; two: "A and B"; many (3+): "A, B and others". */
export function typingLabel(names: string[]): {
  key: 'one' | 'two' | 'many';
  names: string[];
} {
  const key = names.length >= 3 ? 'many' : names.length === 2 ? 'two' : 'one';
  return { key, names: names.slice(0, 2) };
}
