import { describe, expect, it } from 'vitest';

import type { MeetingChatMessage } from '@/lib/meetings/room/contract';

import { firstUnreadId } from './chat';

const line = (id: string, userId: string, createdAt: string) =>
  ({ id, userId, body: id, createdAt }) as MeetingChatMessage;

describe('firstUnreadId', () => {
  const chat = [
    line('a', 'them', '2026-11-05T10:00:00Z'),
    line('b', 'me', '2026-11-05T10:01:00Z'),
    line('c', 'them', '2026-11-05T10:02:00Z'),
  ];

  it('is the first line of someone else after the last one seen', () => {
    expect(firstUnreadId(chat, '2026-11-05T10:00:00Z', 'me')).toBe('c');
  });

  it('counts everything from others when nothing was seen', () => {
    expect(firstUnreadId(chat, null, 'me')).toBe('a');
  });

  it('is null when all is read, or only our own lines are new', () => {
    expect(firstUnreadId(chat, '2026-11-05T10:02:00Z', 'me')).toBeNull();
    expect(firstUnreadId(chat.slice(1, 2), null, 'me')).toBeNull();
  });
});
