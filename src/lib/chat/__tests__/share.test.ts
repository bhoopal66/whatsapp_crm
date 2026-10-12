import { describe, expect, it } from 'vitest';

import { canShareToTeamChat, shareTargets } from '../share';
import type { ChannelWithMembership } from '../types';

const ch = (
  id: string,
  kind: ChannelWithMembership['kind'],
  name: string | null,
  o: { member?: boolean; archived?: boolean } = {}
): ChannelWithMembership => ({
  id,
  accountId: 'ws',
  kind,
  name,
  topic: null,
  dmMemberIds: [],
  createdBy: 'u',
  archivedAt: o.archived ? '2026-10-01T00:00:00Z' : null,
  createdAt: '2026-01-01T00:00:00Z',
  membership: o.member
    ? {
        channelId: id,
        userId: 'me',
        role: 'member',
        joinedAt: '2026-01-01T00:00:00Z',
        lastReadAt: null,
        muted: false,
      }
    : null,
});

const channels = [
  ch('t1', 'team', 'sales', { member: true }),
  ch('t2', 'team', 'mashreq-desk'),
  ch('t3', 'team', 'old', { archived: true, member: true }),
  ch('p1', 'private', 'leads-٢٠٢٦', { member: true }),
  ch('p2', 'private', 'hr'),
  ch('d1', 'dm', null, { member: true }),
  ch('r1', 'deal_room', 'deal ADCB', { member: true }),
];

describe('shareTargets', () => {
  it('offers open team channels and the private ones you are in, joined first', () => {
    expect(shareTargets(channels).map((c) => [c.id, c.joined])).toEqual([
      ['p1', true],
      ['t1', true],
      ['t2', false],
    ]);
  });

  it('filters by name, ignoring case, a leading # and Arabic-Indic digits', () => {
    expect(shareTargets(channels, '#MASH').map((c) => c.id)).toEqual(['t2']);
    expect(shareTargets(channels, '2026').map((c) => c.id)).toEqual(['p1']);
    // 'hr' is a private channel you are not in; mashreq-desk merely contains it.
    expect(shareTargets(channels, 'hr').map((c) => c.id)).toEqual(['t2']);
  });
});

describe('canShareToTeamChat', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['team_leader', true],
    ['agent', true],
    ['viewer', false],
    ['bank_guest', false],
    [null, false],
  ] as const)('%s → %s', (role, ok) => {
    expect(canShareToTeamChat(role)).toBe(ok);
  });
});
