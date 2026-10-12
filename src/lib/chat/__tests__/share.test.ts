import { describe, expect, it } from 'vitest';

import { canShareToTeamChat, sharedCardView, shareTargets } from '../share';
import { toSharedCard, type ChannelWithMembership } from '../types';

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

describe('sharedCardView', () => {
  const snapshot = {
    contact_name: 'Ms Customer',
    phone: '+971 XXXXXXX12',
    company: 'Acme LLC',
    owner: 'Rana',
    last_messages: [
      { sender_type: 'agent', content_text: 'hello', created_at: 't1' },
      {
        sender_type: 'customer',
        content_text: 'my salary is',
        created_at: 't2',
      },
      { sender_type: 'agent', content_text: 'noted', created_at: 't3' },
    ],
  };

  it('maps a no-access row (087 sends no id or snapshot) to no access', () => {
    const card = toSharedCard({
      message_id: 'm1',
      conversation_id: null,
      snapshot: null,
      can_open: false,
      chat_tag: null,
      status: null,
      last_message_at: null,
    });
    expect(card.conversationId).toBeNull();
    expect(card.snapshot.contactName).toBeNull();
    expect(card.snapshot.lastMessages).toEqual([]);
    expect(sharedCardView(card)).toEqual({ access: false });
  });

  it('never shows a snapshot without access, whatever the row carried', () => {
    const card = toSharedCard({
      message_id: 'm1',
      conversation_id: 'cv1',
      snapshot,
      can_open: false,
    });
    const view = sharedCardView(card);
    expect(view).toEqual({ access: false });
    expect(JSON.stringify(view)).not.toContain('Customer');
  });

  it('shows the snapshot and live tag to a viewer', () => {
    const card = toSharedCard({
      message_id: 'm1',
      conversation_id: 'cv1',
      snapshot,
      can_open: true,
      chat_tag: { name: 'Interested', color: '#22c55e' },
      status: 'open',
    });
    expect(sharedCardView(card)).toEqual({
      access: true,
      conversationId: 'cv1',
      name: 'Ms Customer',
      owner: 'Rana',
      details: '+971 XXXXXXX12 · Acme LLC',
      lastMessages: [
        {
          senderType: 'customer',
          contentText: 'my salary is',
          createdAt: 't2',
        },
        { senderType: 'agent', contentText: 'noted', createdAt: 't3' },
      ],
      tag: { name: 'Interested', color: '#22c55e' },
    });
  });
});
