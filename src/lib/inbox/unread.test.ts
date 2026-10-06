import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';

import { firstUnreadMessageId } from './unread';

const m = (id: string, sender_type: Message['sender_type']) => ({
  id,
  sender_type,
});

describe('firstUnreadMessageId', () => {
  it('marks the oldest of the last N customer messages', () => {
    const thread = [
      m('c1', 'customer'),
      m('a1', 'agent'),
      m('c2', 'customer'),
      m('c3', 'customer'),
    ];
    expect(firstUnreadMessageId(thread, 1)).toBe('c3');
    expect(firstUnreadMessageId(thread, 2)).toBe('c2');
  });

  it('skips our own and the bot’s replies while counting', () => {
    const thread = [
      m('c1', 'customer'),
      m('c2', 'customer'),
      m('b1', 'bot'),
      m('c3', 'customer'),
      m('a1', 'agent'),
    ];
    expect(firstUnreadMessageId(thread, 2)).toBe('c2');
  });

  it('falls back to the oldest loaded customer message when the rest are in an older page', () => {
    const thread = [m('a1', 'agent'), m('c1', 'customer'), m('c2', 'customer')];
    expect(firstUnreadMessageId(thread, 5)).toBe('c1');
  });

  it('returns null when nothing is unread or there is no customer message', () => {
    expect(firstUnreadMessageId([m('c1', 'customer')], 0)).toBeNull();
    expect(firstUnreadMessageId([m('a1', 'agent')], 2)).toBeNull();
    expect(firstUnreadMessageId([], 3)).toBeNull();
  });
});
