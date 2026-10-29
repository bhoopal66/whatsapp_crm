import { describe, expect, it } from 'vitest';

import { countUnreadChats, type UnreadCountRow } from './unread-counts';

const row = (
  id: string,
  extra: Partial<UnreadCountRow> = {}
): UnreadCountRow => ({
  id,
  unread_count: 1,
  ...extra,
});

describe('countUnreadChats', () => {
  it('counts the same set for both lists when nothing narrows', () => {
    const rows = [row('a'), row('b', { user_id: 'someone' })];
    expect(countUnreadChats(rows, false, null)).toEqual({ inbox: 2, team: 2 });
  });

  it('leaves read rows out of both', () => {
    expect(
      countUnreadChats([row('a', { unread_count: 0 })], false, null)
    ).toEqual({ inbox: 0, team: 0 });
  });

  it("narrows only a leader's Inbox to their own chats", () => {
    const rows = [
      row('mine', { user_id: 'u9' }),
      row('held', { assigned_agent_id: 'u9' }),
      row('number', { channel_id: 'c1' }),
      row('shared'),
      row('team', { user_id: 'u2', assigned_agent_id: 'u2' }),
    ];
    expect(
      countUnreadChats(rows, false, {
        userId: 'u9',
        channelIds: ['c1'],
        sharedConversationIds: ['shared'],
      })
    ).toEqual({ inbox: 4, team: 5 });
  });

  it('leaves a campaign chat the bot is answering out of both', () => {
    const campaign = row('c', {
      campaign_broadcast_id: 'b1',
      ai_reply_count: 1,
    });
    expect(countUnreadChats([campaign], true, null)).toEqual({
      inbox: 0,
      team: 0,
    });
  });
});
