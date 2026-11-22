import { describe, expect, it } from 'vitest';
import {
  EMPTY_INBOX_VIEW,
  isEmptyInboxView,
  parseInboxView,
} from './inbox-view';

const ID = '11111111-2222-4333-8444-555555555555';

describe('parseInboxView', () => {
  it('reads garbage as the empty view', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}]) {
      expect(parseInboxView(bad)).toEqual(EMPTY_INBOX_VIEW);
    }
  });
  it('round-trips a full view', () => {
    const v = {
      unread: true,
      important: true,
      pinned: true,
      assignee: ID,
      campaignId: ID,
      chatTagIds: [ID],
      insights: ['hot', 'upset'],
      company: 'Acme',
    };
    expect(parseInboxView(v)).toEqual(v);
  });
  it('drops malformed parts and keeps the rest', () => {
    const out = parseInboxView({
      unread: 'yes',
      assignee: 'not-an-id',
      chatTagIds: [ID, 'zzz', 3],
      insights: ['hot', 'bogus'],
      campaignId: 'x',
    });
    expect(out.unread).toBe(false);
    expect(out.assignee).toBeNull();
    expect(out.chatTagIds).toEqual([ID]);
    expect(out.insights).toEqual(['hot']);
    expect(out.campaignId).toBeNull();
  });
  it('accepts the unassigned token', () => {
    expect(parseInboxView({ assignee: 'unassigned' }).assignee).toBe(
      'unassigned'
    );
  });
  it('knows when nothing is set', () => {
    expect(isEmptyInboxView(EMPTY_INBOX_VIEW)).toBe(true);
    expect(isEmptyInboxView({ ...EMPTY_INBOX_VIEW, pinned: true })).toBe(false);
  });
});
