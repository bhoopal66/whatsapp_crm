import { describe, expect, it } from 'vitest';
import {
  TEAM_CHAT_BODY_MAX,
  clipTeamChatBody,
  describeTeamChatPostError,
  teamChatChannelRefusal,
} from './team-chat-post';

describe('teamChatChannelRefusal', () => {
  it('lets a live team or private channel through', () => {
    expect(
      teamChatChannelRefusal({ kind: 'team', archived_at: null })
    ).toBeNull();
    expect(
      teamChatChannelRefusal({ kind: 'private', archived_at: null })
    ).toBeNull();
  });

  it("refuses a DM and a deal room's Team notes", () => {
    expect(teamChatChannelRefusal({ kind: 'dm', archived_at: null })).toBe(
      'post_team_chat: cannot post to a dm channel'
    );
    expect(
      teamChatChannelRefusal({ kind: 'deal_room', archived_at: null })
    ).toBe('post_team_chat: cannot post to a deal_room channel');
  });

  it("refuses a missing (or another account's) channel and an archived one", () => {
    expect(teamChatChannelRefusal(null)).toBe(
      'post_team_chat: channel not found in this workspace'
    );
    expect(
      teamChatChannelRefusal({
        kind: 'team',
        archived_at: '2026-10-01T00:00:00Z',
      })
    ).toBe('post_team_chat: the channel is archived');
  });
});

describe('clipTeamChatBody', () => {
  it('trims and keeps a body within the limit', () => {
    expect(clipTeamChatBody('  hello  ')).toBe('hello');
    const exact = 'a'.repeat(TEAM_CHAT_BODY_MAX);
    expect(clipTeamChatBody(exact)).toBe(exact);
  });

  it('clips to the limit in characters, not UTF-16 units', () => {
    const clipped = clipTeamChatBody('😀'.repeat(TEAM_CHAT_BODY_MAX + 5));
    expect(Array.from(clipped)).toHaveLength(TEAM_CHAT_BODY_MAX);
    expect(clipped.endsWith('😀…')).toBe(true);
  });
});

describe('describeTeamChatPostError', () => {
  it('names the three refusals chat_post_system_message raises', () => {
    expect(describeTeamChatPostError({ code: 'CH001' })).toBe(
      'post_team_chat: team chat is turned off for this workspace'
    );
    expect(describeTeamChatPostError({ code: '42501' })).toBe(
      'post_team_chat: the channel is archived'
    );
    expect(describeTeamChatPostError({ code: 'P0002' })).toBe(
      'post_team_chat: channel not found in this workspace'
    );
  });

  it("keeps the database's wording for anything else", () => {
    expect(describeTeamChatPostError({ code: 'XX000', message: 'boom' })).toBe(
      'post_team_chat failed: boom'
    );
  });
});
