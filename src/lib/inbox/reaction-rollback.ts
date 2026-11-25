import type { MessageReaction } from '@/types';

/** One person's change to their reaction on one message. */
export interface ReactionAttempt {
  conversationId: string;
  messageId: string;
  userId: string;
  /** What they picked; '' takes their reaction off. */
  emoji: string;
  /** Their reaction before it; undefined when they had none. */
  before: MessageReaction | undefined;
}

/** This person's own reaction on this message. */
export function ownReaction(
  reactions: readonly MessageReaction[],
  messageId: string,
  userId: string
): MessageReaction | undefined {
  return reactions.find(
    (r) =>
      r.message_id === messageId &&
      r.actor_type === 'agent' &&
      r.actor_id === userId
  );
}

/**
 * The reactions after `attempt` failed: only that person's reaction on
 * that message goes back, so the ones that arrived meanwhile stay. Left
 * alone when another chat is open, when they have since picked again,
 * and when the server already reported the reaction saved (a real row
 * took the place of the `temp-` one).
 */
export function rollbackReaction(
  reactions: MessageReaction[],
  attempt: ReactionAttempt,
  openConversationId: string | null | undefined
): MessageReaction[] {
  if (openConversationId !== attempt.conversationId) return reactions;
  const { before, emoji } = attempt;
  const own = ownReaction(reactions, attempt.messageId, attempt.userId);
  if (emoji === '') {
    return before && !own ? [...reactions, before] : reactions;
  }
  if (!own || own.emoji !== emoji) return reactions;
  if (before) {
    return own.id === before.id
      ? reactions.map((r) => (r === own ? before : r))
      : reactions;
  }
  return own.id.startsWith('temp-')
    ? reactions.filter((r) => r !== own)
    : reactions;
}
