import { describe, expect, it } from 'vitest';

import { toChatError, type ChatErrorKey } from '../errors';
import { UI_ERROR_KEYS, chatErrorKey } from '../view';

// The wording 157/158 raise (and the restrictions and audience
// migrations being written), each with its SQLSTATE.
const CASES: [string, string, ChatErrorKey][] = [
  ['42501', 'chat: your role may not upload files', 'permissionDenied'],
  ['42501', 'chat: only channel admins can post here', 'postingRestricted'],
  [
    '42501',
    'chat: only channel admins can reply in threads here',
    'repliesRestricted',
  ],
  [
    '42501',
    'chat: you may not notify everyone in this channel (only channel admins can)',
    'mentionEveryoneRestricted',
  ],
  [
    '42501',
    'chat: the edit window has passed (15 minutes)',
    'editWindowClosed',
  ],
  [
    '42501',
    'chat: the delete window has passed (60 minutes)',
    'deleteWindowClosed',
  ],
  [
    '42501',
    'chat: this message contains sensitive data (card, emirates_id) and this workspace blocks it in channels with bank guests',
    'sensitiveData',
  ],
  [
    '42501',
    'chat: you are restricted from posting in this channel',
    'restrictedPosting',
  ],
  ['22023', 'chat_restrict_member: a reason is required', 'reasonRequired'],
  [
    '22023',
    'chat_set_audience: that audience would hide this channel from you',
    'audienceHidesYou',
  ],
  ['42501', "chat: outside this channel's audience", 'outsideAudience'],
];

describe('157/158 refusals → ChatError keys', () => {
  it.each(CASES)('%s %s → %s', (code, message, key) => {
    const e = toChatError({ code, message });
    expect(e.key).toBe(key);
    expect(UI_ERROR_KEYS).toContain(key);
    expect(chatErrorKey(e)).toBe(key);
  });

  it('keeps the older adminRequired wording', () => {
    expect(
      toChatError({
        code: '42501',
        message:
          'chat_add_members: only channel admins can add members to a private channel',
      }).key
    ).toBe('adminRequired');
  });
});
