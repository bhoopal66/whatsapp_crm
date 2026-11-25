import { describe, expect, it } from 'vitest';

import type { MessageReaction } from '@/types';
import { rollbackReaction, type ReactionAttempt } from './reaction-rollback';

function reaction(over: Partial<MessageReaction>): MessageReaction {
  return {
    id: 'r1',
    message_id: 'm1',
    conversation_id: 'A',
    actor_type: 'agent',
    actor_id: 'me',
    emoji: '👍',
    created_at: '2026-11-25T10:00:00Z',
    ...over,
  };
}

const attempt: ReactionAttempt = {
  conversationId: 'A',
  messageId: 'm1',
  userId: 'me',
  emoji: '👍',
  before: undefined,
};
const mine = reaction({ id: 'temp-1' });
// Arrived while the request was out.
const theirs = reaction({
  id: 'r9',
  actor_type: 'customer',
  actor_id: 'c1',
  emoji: '❤️',
});
const colleague = reaction({ id: 'r8', actor_id: 'other' });

describe('rollbackReaction', () => {
  it('takes the new reaction off and keeps the ones that arrived', () => {
    expect(rollbackReaction([mine, theirs, colleague], attempt, 'A')).toEqual([
      theirs,
      colleague,
    ]);
  });

  it('touches nothing once another chat is open', () => {
    const inB = [
      reaction({ id: 'b1', message_id: 'm2', conversation_id: 'B' }),
    ];
    const removed = { ...attempt, emoji: '', before: reaction({}) };
    expect(rollbackReaction(inB, attempt, 'B')).toBe(inB);
    expect(rollbackReaction(inB, removed, 'B')).toBe(inB);
    expect(rollbackReaction([], removed, undefined)).toEqual([]);
  });

  it('puts the earlier emoji back after a failed change', () => {
    const before = reaction({ emoji: '😂' });
    expect(
      rollbackReaction(
        [reaction({ emoji: '👍' }), theirs],
        { ...attempt, before },
        'A'
      )
    ).toEqual([before, theirs]);
  });

  it('puts a reaction back that could not be taken off', () => {
    const before = reaction({});
    const removed = { ...attempt, emoji: '', before };
    expect(rollbackReaction([theirs], removed, 'A')).toEqual([theirs, before]);
    // A resync already brought it back.
    expect(rollbackReaction([before], removed, 'A')).toEqual([before]);
  });

  it('leaves a later pick alone', () => {
    const later = [reaction({ id: 'temp-1', emoji: '🙏' })];
    expect(rollbackReaction(later, attempt, 'A')).toBe(later);
  });

  it('keeps a reaction the server reported saved', () => {
    const saved = [reaction({ id: 'r5' })];
    expect(rollbackReaction(saved, attempt, 'A')).toBe(saved);
  });
});
