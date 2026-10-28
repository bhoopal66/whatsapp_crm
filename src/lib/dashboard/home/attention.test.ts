import { describe, expect, it } from 'vitest';

import {
  countInboxUnread,
  formatCount,
  inboxHrefFor,
  overdueCases,
  tileState,
} from './attention';

const row = (over: Record<string, unknown> = {}) => ({
  unread_count: 2,
  campaign_broadcast_id: null,
  human_engaged_at: null,
  assigned_agent_id: undefined,
  ai_autoreply_disabled: false,
  ai_reply_count: 0,
  chat_tag_id: null,
  ...over,
});

describe('countInboxUnread', () => {
  const botChat = row({ campaign_broadcast_id: 'b1', ai_reply_count: 1 });

  it('leaves out a campaign chat the live bot is answering', () => {
    expect(countInboxUnread([row(), botChat], true)).toBe(1);
  });

  it('counts that chat when the bot is not live', () => {
    expect(countInboxUnread([row(), botChat], false)).toBe(2);
  });

  it('ignores rows with nothing unread', () => {
    expect(countInboxUnread([row({ unread_count: 0 }), row()], true)).toBe(1);
  });
});

describe('overdueCases', () => {
  it('counts overdue rows and those with the customer waiting', () => {
    expect(
      overdueCases([
        { slaState: 'overdue', customerWaiting: true },
        { slaState: 'overdue', customerWaiting: false },
        { slaState: 'due_soon', customerWaiting: true },
        { slaState: null, customerWaiting: false },
      ])
    ).toEqual({ overdue: 2, waiting: 1 });
  });
});

describe('tileState', () => {
  it('loads until a count exists, and errors only without one', () => {
    expect(tileState(null, false)).toBe('loading');
    expect(tileState(null, true)).toBe('error');
    expect(tileState(3, true)).toBe('alert');
  });

  it('reads zero as clear and more as alert', () => {
    expect(tileState(0, false)).toBe('clear');
    expect(tileState(1, false)).toBe('alert');
  });
});

describe('tileState with a second set', () => {
  it('stays an alert while the second set is non-empty', () => {
    expect(tileState(0, false, 2)).toBe('alert');
    expect(tileState(0, false, 0)).toBe('clear');
    expect(tileState(null, false, 2)).toBe('loading');
  });
});

describe('inboxHrefFor', () => {
  it('sends a team leader to the team inbox and everyone else to theirs', () => {
    expect(inboxHrefFor('team_leader')).toBe('/team-inbox');
    for (const r of ['owner', 'admin', 'agent', 'viewer', null, undefined])
      expect(inboxHrefFor(r)).toBe('/inbox');
  });
});

describe('formatCount', () => {
  it('marks a cut-short list with +', () => {
    expect(formatCount(12)).toBe('12');
    expect(formatCount(12, true)).toBe('12+');
  });
});
