import { describe, expect, it } from 'vitest';

import {
  MESSAGE_SOUND_THROTTLE_MS,
  messageSoundKey,
  openChatId,
  shouldPlayMessageSound,
  soundWorthyChat,
  unreadRose,
} from './message-sound';

describe('unreadRose', () => {
  it('is a rise only when the count goes up', () => {
    expect(unreadRose(0, 1)).toBe(true);
    expect(unreadRose(undefined, 1)).toBe(true);
    expect(unreadRose(2, 3)).toBe(true);
    expect(unreadRose(3, 3)).toBe(false);
    expect(unreadRose(3, 0)).toBe(false);
    expect(unreadRose(null, null)).toBe(false);
  });
});

describe('soundWorthyChat', () => {
  // A chat the bot has answered; with a campaign id it is a bot chat.
  const row: Parameters<typeof soundWorthyChat>[0] = {
    campaign_broadcast_id: undefined,
    human_engaged_at: undefined,
    assigned_agent_id: undefined,
    ai_autoreply_disabled: false,
    ai_reply_count: 1,
    chat_tag_id: null,
    personal_owner_id: null,
  };

  it('takes an ordinary company chat', () => {
    expect(soundWorthyChat(row, true, 'me')).toBe(true);
  });

  it('leaves out someone else’s personal chat, not one’s own', () => {
    expect(
      soundWorthyChat({ ...row, personal_owner_id: 'other' }, false, 'me')
    ).toBe(false);
    expect(
      soundWorthyChat({ ...row, personal_owner_id: 'me' }, false, 'me')
    ).toBe(true);
  });

  it('leaves out a campaign chat the bot is answering', () => {
    expect(
      soundWorthyChat({ ...row, campaign_broadcast_id: 'b1' }, true, 'me')
    ).toBe(false);
    expect(
      soundWorthyChat({ ...row, campaign_broadcast_id: 'b1' }, false, 'me')
    ).toBe(true);
  });
});

describe('openChatId', () => {
  it('reads ?c= on the inbox routes only', () => {
    expect(openChatId('/inbox', '?c=abc')).toBe('abc');
    expect(openChatId('/team-inbox/', '?c=abc&x=1')).toBe('abc');
    expect(openChatId('/hr/recruiter', '?c=abc')).toBe('abc');
    expect(openChatId('/contacts', '?c=abc')).toBe(null);
    expect(openChatId('/inbox', '')).toBe(null);
    expect(openChatId(null, null)).toBe(null);
  });
});

describe('shouldPlayMessageSound', () => {
  const base = {
    enabled: true,
    conversationId: 'c1',
    openConversationId: null,
    tabFocused: true,
    now: 10_000,
    lastPlayedAt: null,
  };

  it('is off unless switched on', () => {
    expect(shouldPlayMessageSound({ ...base, enabled: false })).toBe(false);
    expect(shouldPlayMessageSound(base)).toBe(true);
  });

  it('stays quiet for the chat open in a focused tab', () => {
    expect(shouldPlayMessageSound({ ...base, openConversationId: 'c1' })).toBe(
      false
    );
    expect(
      shouldPlayMessageSound({
        ...base,
        openConversationId: 'c1',
        tabFocused: false,
      })
    ).toBe(true);
    expect(shouldPlayMessageSound({ ...base, openConversationId: 'c2' })).toBe(
      true
    );
  });

  it('plays at most once per throttle window', () => {
    expect(
      shouldPlayMessageSound({
        ...base,
        lastPlayedAt: base.now - MESSAGE_SOUND_THROTTLE_MS + 1,
      })
    ).toBe(false);
    expect(
      shouldPlayMessageSound({
        ...base,
        lastPlayedAt: base.now - MESSAGE_SOUND_THROTTLE_MS,
      })
    ).toBe(true);
  });

  it('keeps the switch per person', () => {
    expect(messageSoundKey('a')).not.toBe(messageSoundKey('b'));
  });
});
