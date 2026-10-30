import { describe, expect, it } from 'vitest';

import {
  FORWARD_MAX_TARGETS,
  forwardPreview,
  forwardTargets,
  toggleForwardTarget,
} from '../forward';
import type { ChannelWithMembership, ChatAttachment } from '../types';

const ME = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const ALI = '33333333-3333-4333-8333-333333333333';
const peopleById = new Map([
  [SARA, { fullName: 'Sara Ahmed' }],
  [ALI, { fullName: 'Ali Hassan' }],
]);
const member = (channelId: string) => ({
  channelId,
  userId: ME,
  role: 'member' as const,
  joinedAt: '2026-10-01T00:00:00Z',
  lastReadAt: null,
  muted: false,
});
const ch = (
  id: string,
  kind: ChannelWithMembership['kind'],
  o: Partial<ChannelWithMembership> & { joined?: boolean } = {}
): ChannelWithMembership => {
  const { joined = true, ...rest } = o;
  return {
    id,
    accountId: 'a1',
    kind,
    name: kind === 'dm' ? null : id,
    topic: null,
    dmMemberIds: [],
    createdBy: ME,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    membership: joined ? member(id) : null,
    ...rest,
  };
};
const opts = { selfId: ME, peopleById, unknown: 'Someone' };

const channels = [
  ch('sales', 'team'),
  ch('ops', 'team', { joined: false }),
  ch('old', 'team', { archivedAt: '2026-10-02T00:00:00Z' }),
  ch('board', 'private'),
  ch('secret', 'private', { joined: false }),
  ch('room', 'deal_room'),
  ch('dm-sara', 'dm', { dmMemberIds: [ME, SARA] }),
  ch('dm-group', 'dm', { dmMemberIds: [ME, SARA, ALI] }),
  ch('dm-gone', 'dm', { dmMemberIds: [ME, ALI], joined: false }),
];

describe('forwardTargets', () => {
  it('offers team channels, joined private channels and DMs; channels first, by name', () => {
    expect(
      forwardTargets(channels, opts).map((t) => [t.id, t.kind, t.joined])
    ).toEqual([
      ['board', 'private', true],
      ['ops', 'team', false],
      ['sales', 'team', true],
      ['dm-sara', 'dm', true],
      ['dm-group', 'dm', true],
    ]);
  });

  it('names a DM by its other members', () => {
    const dm = forwardTargets(channels, opts).find((t) => t.id === 'dm-sara');
    expect(dm?.name).toBe('Sara Ahmed');
  });

  it('never offers a deal room, an archived channel, a private channel or DM one is not in, or the source', () => {
    const ids = forwardTargets(channels, { ...opts, exclude: 'sales' }).map(
      (t) => t.id
    );
    for (const gone of ['room', 'old', 'secret', 'dm-gone', 'sales'])
      expect(ids).not.toContain(gone);
  });

  it('filters by name, case-insensitively, ignoring a leading # or @', () => {
    expect(
      forwardTargets(channels, { ...opts, query: '#SAL' }).map((t) => t.id)
    ).toEqual(['sales']);
    expect(
      forwardTargets(channels, { ...opts, query: '@sara' }).map((t) => t.id)
    ).toEqual(['dm-sara', 'dm-group']);
    expect(forwardTargets(channels, { ...opts, query: 'zzz' })).toEqual([]);
  });
});

describe('toggleForwardTarget', () => {
  it('ticks in order, unticks, and stops at the limit', () => {
    let picked: string[] = [];
    for (let i = 0; i < FORWARD_MAX_TARGETS + 2; i++)
      picked = toggleForwardTarget(picked, `c${i}`);
    expect(picked).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(toggleForwardTarget(picked, 'c2')).toEqual(['c0', 'c1', 'c3', 'c4']);
  });
});

describe('forwardPreview', () => {
  const file = (o: Partial<ChatAttachment>): ChatAttachment => ({
    id: 'f',
    messageId: 'm',
    storagePath: 'p',
    name: 'offer.pdf',
    mime: 'application/pdf',
    bytes: 1,
    kind: 'file',
    durationMs: null,
    ...o,
  });
  it('shows the first non-blank line, else a voice note, else the first file', () => {
    expect(
      forwardPreview({ attachments: [file({})] }, '\n  hi there \nmore')
    ).toEqual({ kind: 'text', text: 'hi there', files: 1 });
    expect(
      forwardPreview(
        { attachments: [file({ kind: 'voice', durationMs: 3000 })] },
        ' '
      )
    ).toEqual({ kind: 'voice', files: 1 });
    expect(forwardPreview({ attachments: [file({}), file({})] }, '')).toEqual({
      kind: 'files',
      name: 'offer.pdf',
      files: 2,
    });
    expect(forwardPreview({ attachments: [] }, '')).toEqual({ kind: 'empty' });
  });
});
