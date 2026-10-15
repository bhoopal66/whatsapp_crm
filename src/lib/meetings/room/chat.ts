// The room's chat and reactions (`meeting_messages`, migration 107):
// read from the API and from realtime INSERTs, which overlap, so every
// merge dedupes by id.

import {
  MEETING_REACTIONS,
  type MeetingChatMessage,
  type MeetingReaction,
  type MeetingReactionEvent,
} from './contract';

/** A reaction floats over the grid this long after it arrives. */
export const REACTION_TTL_MS = 6_000;
/** The chat keeps at most this many lines. */
export const CHAT_LIMIT = 500;

export type ParsedMessage =
  | { kind: 'chat'; message: MeetingChatMessage }
  | { kind: 'reaction'; reaction: MeetingReactionEvent };

/** One `meeting_messages` row (realtime or API), or null if malformed. */
export function parseMeetingMessage(value: unknown): ParsedMessage | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const { id, user_id, kind, body, created_at } = r;
  if (
    typeof id !== 'string' ||
    !id ||
    typeof user_id !== 'string' ||
    typeof body !== 'string' ||
    typeof created_at !== 'string'
  ) {
    return null;
  }
  if (kind === 'chat') {
    return {
      kind,
      message: { id, userId: user_id, body, createdAt: created_at },
    };
  }
  if (
    kind === 'reaction' &&
    (MEETING_REACTIONS as readonly string[]).includes(body)
  ) {
    return {
      kind,
      reaction: {
        id,
        userId: user_id,
        emoji: body as MeetingReaction,
        createdAt: created_at,
      },
    };
  }
  return null;
}

/**
 * `incoming` merged into `chat`: ascending by createdAt (then id), no
 * id twice, the latest CHAT_LIMIT kept. Returns `chat` itself when
 * nothing is new, so the snapshot does not change.
 */
export function mergeChat(
  chat: readonly MeetingChatMessage[],
  incoming: readonly MeetingChatMessage[]
): MeetingChatMessage[] {
  const seen = new Set(chat.map((m) => m.id));
  const fresh = incoming.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if (!fresh.length) return chat as MeetingChatMessage[];
  return [...chat, ...fresh]
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id)
    )
    .slice(-CHAT_LIMIT);
}

/** A reaction with the local time it arrived (server times may be skewed). */
export interface HeldReaction {
  event: MeetingReactionEvent;
  receivedAt: number;
}

export function addReaction(
  held: readonly HeldReaction[],
  event: MeetingReactionEvent,
  now: number
): HeldReaction[] {
  if (held.some((h) => h.event.id === event.id)) {
    return held as HeldReaction[];
  }
  return [...held, { event, receivedAt: now }];
}

/** Drops reactions older than the TTL; the same array when none expired. */
export function pruneReactions(
  held: readonly HeldReaction[],
  now: number
): HeldReaction[] {
  const kept = held.filter((h) => now - h.receivedAt < REACTION_TTL_MS);
  return kept.length === held.length ? (held as HeldReaction[]) : kept;
}
