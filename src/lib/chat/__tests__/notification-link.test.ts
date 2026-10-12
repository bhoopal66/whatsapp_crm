import { describe, expect, it } from 'vitest';

import {
  chatNotificationHref,
  isChatNotificationType,
} from '../notification-link';

const CH = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

describe('chatNotificationHref', () => {
  it.each(['chat_mention', 'chat_dm', 'chat_broadcast'])(
    '%s opens the channel',
    (type) => {
      expect(
        chatNotificationHref(type, {
          channel_id: CH,
          message_id: MSG,
          thread_root_id: null,
        })
      ).toBe(`/chat/${CH}`);
    }
  );

  it('opens the thread when the message is a reply', () => {
    expect(
      chatNotificationHref('chat_thread_reply', {
        channel_id: CH,
        message_id: MSG,
        thread_root_id: ROOT,
      })
    ).toBe(`/chat/${CH}?thread=${ROOT}`);
    expect(
      chatNotificationHref('chat_mention', {
        channel_id: CH,
        thread_root_id: ROOT,
      })
    ).toBe(`/chat/${CH}?thread=${ROOT}`);
  });

  it('opens nothing for other types or malformed meta', () => {
    expect(
      chatNotificationHref('conversation_assigned', { channel_id: CH })
    ).toBe(null);
    expect(chatNotificationHref('chat_mention', null)).toBe(null);
    expect(chatNotificationHref('chat_mention', {})).toBe(null);
    expect(
      chatNotificationHref('chat_mention', { channel_id: '../settings' })
    ).toBe(null);
    expect(
      chatNotificationHref('chat_mention', {
        channel_id: CH,
        thread_root_id: 'nope',
      })
    ).toBe(`/chat/${CH}`);
  });

  it('knows the four chat types', () => {
    expect(isChatNotificationType('chat_dm')).toBe(true);
    expect(isChatNotificationType('task_assigned')).toBe(false);
  });
});
