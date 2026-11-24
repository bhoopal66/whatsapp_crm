/**
 * Migration 277: chat_people lists deactivated people too, so their names
 * stay. Everything that offers people must leave them out, and everything
 * that counted "not listed" as "left" must count them as left.
 */
import { describe, expect, it } from 'vitest';

import { addPeopleCandidates } from '@/lib/deal-rooms/people-ui';

import { dmCandidates } from '../compose';
import { deserializeBody, mentionCandidates } from '../composer';
import { forwardTargets } from '../forward';
import { canRemoveMember, leaveBlock, roleChange } from '../membership';
import { privateMemberCandidates } from '../new-channel';
import { addPickerRows } from '../panels';
import { matchPeople } from '../search-view';
import {
  toChatPerson,
  type ChannelMember,
  type ChannelWithMembership,
} from '../types';
import { channelDisplayName } from '../view';

const ME = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const SAMI = '33333333-3333-4333-8333-333333333333';
const GUS = '44444444-4444-4444-8444-444444444444';

const row = (user_id: string, full_name: string, role = 'agent') => ({
  user_id,
  full_name,
  role,
});
const people = [
  toChatPerson(row(ME, 'Me')),
  toChatPerson({ ...row(SARA, 'Sara Ahmed'), deactivated: false }),
  toChatPerson({ ...row(SAMI, 'Sami Left'), deactivated: true }),
  toChatPerson({ ...row(GUS, 'Sal Guest', 'bank_guest'), deactivated: true }),
];
const peopleById = new Map(people.map((p) => [p.userId, p]));
const ids = (list: readonly { userId: string }[]) => list.map((p) => p.userId);

const member = (
  userId: string,
  role: ChannelMember['role']
): ChannelMember => ({
  channelId: 'c1',
  userId,
  role,
  joinedAt: '2026-10-01T00:00:00Z',
  lastReadAt: null,
  muted: false,
});

describe('a deactivated person', () => {
  it('is read from the row; a database without the flag has none', () => {
    expect(people.map((p) => p.deactivated)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('keeps their name in a DM title and in a mention', () => {
    const dm = { kind: 'dm' as const, name: null, dmMemberIds: [ME, SAMI] };
    expect(channelDisplayName(dm, ME, peopleById, 'Unknown')).toBe('Sami Left');
    expect(deserializeBody(`hi <@${SAMI}>`, peopleById).text).toBe(
      'hi @Sami Left'
    );
  });

  it('is in no picker', () => {
    expect(ids(dmCandidates(people, ME))).toEqual([SARA]);
    expect(ids(privateMemberCandidates(people, ME, 'owner'))).toEqual([SARA]);
    const rows = addPickerRows(
      people,
      [{ userId: ME }],
      { staff: true, guests: false, block: null },
      'team'
    );
    expect(ids(rows.map((r) => r.person))).toEqual([SARA]);
    expect(ids(matchPeople(people, 'sa'))).toEqual([SARA]);
    expect(
      mentionCandidates(people, 'sa', { broadcasts: false }).map((c) =>
        c.type === 'person' ? c.person.userId : c.kind
      )
    ).toEqual([SARA]);
    expect(ids(addPeopleCandidates(people, [{ userId: ME }], 'staff'))).toEqual(
      [SARA]
    );
    expect(addPeopleCandidates(people, [], 'guest')).toEqual([]);
  });

  it('is forwarded nothing: a DM with nobody else active is not a target', () => {
    const dm = (id: string, dmMemberIds: string[]) =>
      ({
        id,
        kind: 'dm',
        name: null,
        dmMemberIds,
        archivedAt: null,
        posting: 'everyone',
        membership: member(ME, 'member'),
      }) as unknown as ChannelWithMembership;
    const targets = forwardTargets(
      [
        dm('left', [ME, SAMI]),
        dm('both', [ME, SAMI, SARA]),
        dm('self', [ME]),
        dm('removed', [ME, 'not-listed']),
      ],
      { selfId: ME, peopleById, unknown: 'Unknown', accountRole: 'agent' }
    );
    expect(targets.map((t) => t.id).sort()).toEqual([
      'both',
      'removed',
      'self',
    ]);
  });

  it('does not count as another channel admin, as in SQL', () => {
    const members = [member(ME, 'admin'), member(SAMI, 'admin')];
    const base = {
      kind: 'private' as const,
      archived: false,
      myRole: 'admin' as const,
      accountRole: 'owner',
      members,
      peopleById,
      userId: ME,
    };
    expect(leaveBlock({ ...base, dmMemberIds: [] })).toBe('lastAdmin');
    expect(roleChange(members[0], base)).toEqual({
      to: 'member',
      block: 'lastAdmin',
    });
    // Removing the one who left is fine: the viewer is still an admin.
    expect(canRemoveMember(members[1], base)).toBe(true);
    const sara = member(SARA, 'admin');
    expect(
      canRemoveMember(sara, {
        ...base,
        kind: 'team',
        myRole: null,
        members: [sara, members[1]],
      })
    ).toBe(false);
  });
});
