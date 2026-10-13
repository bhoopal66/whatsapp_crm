import { describe, expect, it } from 'vitest';
import { parseMentions } from '@/lib/chat/mentions';
import { boldSegments } from '@/lib/chat/view';
import {
  TEAM_CHAT_BODY_MAX,
  TEAM_CHAT_GUEST_REFUSAL,
  clipTeamChatBody,
  describeTeamChatPostError,
  neutraliseTeamChatValue,
  teamChatChannelRefusal,
  teamChatGuestRefusal,
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

describe('teamChatGuestRefusal', () => {
  it('lets a channel with no bank guest through', () => {
    expect(teamChatGuestRefusal([])).toBeNull();
  });

  it('refuses a channel the check names', () => {
    expect(teamChatGuestRefusal(['ch-1'])).toBe(TEAM_CHAT_GUEST_REFUSAL);
  });

  it('fails closed on an answer that is not a list', () => {
    expect(teamChatGuestRefusal(null)).toBe(
      'post_team_chat: could not check the channel for bank guests'
    );
    expect(teamChatGuestRefusal(undefined)).toBe(
      'post_team_chat: could not check the channel for bank guests'
    );
  });
});

describe('neutraliseTeamChatValue', () => {
  const uuid = '0b7e2d4c-1f3a-4e5b-8c9d-0a1b2c3d4e5f';

  it("leaves a customer's **…** unrendered", () => {
    const body = `New lead: ${neutraliseTeamChatValue('**FREE** offer')}`;
    expect(boldSegments(body)).toEqual([{ text: body, bold: false }]);
  });

  it("keeps an unmatched ** from scrambling the template's own bold", () => {
    const body = `${neutraliseTeamChatValue('hi **')} - **urgent**`;
    expect(boldSegments(body)).toEqual([
      { text: 'hi \u2217\u2217 - ', bold: false },
      { text: 'urgent', bold: true },
    ]);
  });

  it('leaves no user or broadcast mention to render', () => {
    const value = neutraliseTeamChatValue(
      `<@${uuid}> @here @Channel (@HERE). ping`
    );
    expect(parseMentions(value)).toEqual({ userIds: [], broadcast: [] });
    expect(value).toBe(
      `<\uFF20${uuid}> \uFF20here \uFF20Channel (\uFF20HERE). ping`
    );
  });

  it('keeps e-mail addresses and words that only start like a broadcast', () => {
    expect(neutraliseTeamChatValue('me@here.example @heresy @channels')).toBe(
      'me@here.example @heresy @channels'
    );
  });
});
