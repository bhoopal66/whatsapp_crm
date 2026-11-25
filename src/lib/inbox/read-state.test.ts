import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UNREAD_RESET_RETRY_MS,
  shouldMarkRead,
  startUnreadReset,
  unreadAfterInsert,
  unreadAfterUpdate,
  unreadResetKey,
  zeroUnreadOf,
} from './read-state';

const open = { isOpen: true, visible: true };
const hidden = { isOpen: true, visible: false };
const other = { isOpen: false, visible: true };
const customer = { sender_type: 'customer' as const };
const agent = { sender_type: 'agent' as const };

describe('a chat open in a hidden tab stays unread', () => {
  it('on the server', () => {
    const chat = { conversationId: 'c1', unreadKey: '1@t', visible: true };
    expect(shouldMarkRead(chat)).toBe(true);
    expect(shouldMarkRead({ ...chat, visible: false })).toBe(false);
    expect(shouldMarkRead({ ...chat, unreadKey: null })).toBe(false);
    expect(shouldMarkRead({ ...chat, conversationId: undefined })).toBe(false);
  });

  it('in the list', () => {
    expect(unreadAfterInsert(2, customer, open)).toBe(0);
    expect(unreadAfterInsert(2, customer, hidden)).toBe(3);
    expect(unreadAfterInsert(2, agent, hidden)).toBe(2);
    expect(unreadAfterInsert(2, customer, other)).toBe(3);
    expect(unreadAfterUpdate(4, open)).toBe(0);
    expect(unreadAfterUpdate(4, hidden)).toBe(4);
    expect(unreadAfterUpdate(4, other)).toBe(4);
  });

  it('until it is shown again', () => {
    const list = [
      { id: 'c1', unread_count: 3 },
      { id: 'c2', unread_count: 1 },
    ];
    expect(zeroUnreadOf(list, 'c1').map((c) => c.unread_count)).toEqual([0, 1]);
    expect(zeroUnreadOf(list, 'c9')).toBe(list);
    expect(zeroUnreadOf(list, undefined)).toBe(list);
  });
});

describe('unreadResetKey', () => {
  const at = (unread_count: number, updated_at = 't1') =>
    unreadResetKey({ unread_count, updated_at });
  it('is null for a read chat, so the reset does not repeat itself', () => {
    expect(at(0)).toBeNull();
    expect(unreadResetKey(null)).toBeNull();
  });
  it('changes when a reset and the next message arrive in one render', () => {
    // unread 1 → our 0 and the next message's 1, only the last one drawn.
    expect(at(1, 't3')).not.toBe(at(1, 't1'));
    expect(at(2)).not.toBe(at(1));
  });
});

describe('startUnreadReset', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('does not repeat a reset that worked', async () => {
    const attempt = vi.fn(async () => true);
    startUnreadReset(attempt);
    await vi.advanceTimersByTimeAsync(UNREAD_RESET_RETRY_MS * 3);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('tries a failed one again, once', async () => {
    const attempt = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(false);
    startUnreadReset(attempt);
    await vi.advanceTimersByTimeAsync(UNREAD_RESET_RETRY_MS - 1);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UNREAD_RESET_RETRY_MS * 3);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('drops the retry when the chat is left or hidden', async () => {
    const attempt = vi.fn(async () => false);
    const cancel = startUnreadReset(attempt);
    await vi.advanceTimersByTimeAsync(10);
    cancel();
    await vi.advanceTimersByTimeAsync(UNREAD_RESET_RETRY_MS * 3);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
