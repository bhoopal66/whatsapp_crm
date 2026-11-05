import { describe, expect, it } from 'vitest';

import {
  inviteCandidates,
  parseInviteeIds,
  peopleCount,
  peopleSections,
  PEOPLE_SEARCH_FROM,
  type PanelPerson,
} from './panels';

const person = (id: string, over: Partial<PanelPerson> = {}): PanelPerson => ({
  id,
  userId: `u-${id}`,
  name: id,
  isSelf: false,
  handRaisedAt: null,
  micOn: true,
  cameraOn: true,
  ...over,
});

const sections = (over: Partial<Parameters<typeof peopleSections>[0]>) =>
  peopleSections({
    people: [],
    hostUserId: null,
    inviteeUserIds: [],
    removedUserIds: [],
    nameOf: (id) => id.replace('u-', ''),
    unknownName: 'Someone',
    query: '',
    ...over,
  });

const crowd = Array.from({ length: PEOPLE_SEARCH_FROM }, (_, i) =>
  person(`p${i}`)
);

describe('peopleSections', () => {
  it('numbers the hands in the order they went up, the rest stay here', () => {
    const s = sections({
      people: [
        person('first', { handRaisedAt: '2026-01-01T00:00:01Z' }),
        person('second', { handRaisedAt: '2026-01-01T00:00:02Z' }),
        person('quiet'),
      ],
    });
    expect(s.hands.map((p) => [p.name, p.queuePosition])).toEqual([
      ['first', 1],
      ['second', 2],
    ]);
    expect(s.here.map((p) => p.name)).toEqual(['quiet']);
    expect(s.here[0].queuePosition).toBeNull();
  });

  it('flags the organiser wherever they sit', () => {
    const s = sections({
      people: [
        person('boss', { handRaisedAt: '2026-01-01T00:00:01Z' }),
        person('other'),
      ],
      hostUserId: 'u-boss',
    });
    expect(s.hands[0].isOrganiser).toBe(true);
    expect(s.here[0].isOrganiser).toBe(false);
  });

  it('lists invitees not here yet, once, by name', () => {
    const s = sections({
      people: [person('here')],
      inviteeUserIds: ['u-zed', 'u-here', 'u-amy', 'u-zed'],
    });
    expect(s.invited.map((p) => p.name)).toEqual(['amy', 'zed']);
  });

  it('never shows a removed invitee as still expected', () => {
    const s = sections({
      inviteeUserIds: ['u-out', 'u-amy'],
      removedUserIds: ['u-out'],
    });
    expect(s.invited.map((p) => p.userId)).toEqual(['u-amy']);
    expect(s.removed.map((p) => p.userId)).toEqual(['u-out']);
  });

  it('names an unknown person with the fallback', () => {
    const s = sections({
      inviteeUserIds: ['x'],
      nameOf: () => null,
    });
    expect(s.invited[0].name).toBe('Someone');
  });

  it('offers search from the threshold, counting every section', () => {
    expect(sections({ people: crowd.slice(1) }).searchable).toBe(false);
    expect(sections({ people: crowd }).searchable).toBe(true);
    expect(
      sections({
        people: crowd.slice(2),
        inviteeUserIds: ['u-a'],
        removedUserIds: ['u-b'],
      }).searchable
    ).toBe(true);
  });

  it('filters every section by name, ignoring case and spaces', () => {
    const s = sections({
      people: [
        ...crowd,
        person('Sara hand', { handRaisedAt: '2026-01-01T00:00:01Z' }),
        person('Sara here'),
      ],
      inviteeUserIds: ['u-sara invited', 'u-omar'],
      removedUserIds: ['u-SARA removed', 'u-khalid'],
      query: '  sARA ',
    });
    expect(s.hands.map((p) => p.name)).toEqual(['Sara hand']);
    expect(s.here.map((p) => p.name)).toEqual(['Sara here']);
    expect(s.invited.map((p) => p.name)).toEqual(['sara invited']);
    expect(s.removed.map((p) => p.name)).toEqual(['SARA removed']);
  });

  it('keeps a hand at its place in the queue while searching', () => {
    const s = sections({
      people: [
        person('first', { handRaisedAt: '2026-01-01T00:00:01Z' }),
        person('second', { handRaisedAt: '2026-01-01T00:00:02Z' }),
        ...crowd,
      ],
      query: 'second',
    });
    expect(s.hands.map((p) => p.queuePosition)).toEqual([2]);
  });

  it('ignores a query left over once the box has gone', () => {
    const s = sections({ people: [person('a')], query: 'nobody' });
    expect(s.searchable).toBe(false);
    expect(s.here).toHaveLength(1);
  });
});

describe('parseInviteeIds', () => {
  it('reads the route key and drops anything else', () => {
    expect(parseInviteeIds({ invitee_user_ids: ['a', 1, 'b'] })).toEqual([
      'a',
      'b',
    ]);
    expect(parseInviteeIds({ invitees: ['a'] })).toEqual([]);
    expect(parseInviteeIds({ invitee_user_ids: 'a' })).toEqual([]);
    expect(parseInviteeIds(null)).toEqual([]);
  });
});

describe('peopleCount', () => {
  it('counts ourselves once, with or without our row', () => {
    expect(peopleCount([{ id: 'a' }, { id: 'me' }], 'me')).toBe(2);
    expect(peopleCount([{ id: 'a' }], 'me')).toBe(2);
    expect(peopleCount([], null)).toBe(1);
  });
});

describe('inviteCandidates', () => {
  const member = (
    id: string,
    full_name: string,
    over: { email?: string | null; deactivated_at?: string | null } = {}
  ) => ({ user_id: id, full_name, email: null, ...over });

  it('leaves out the deactivated and anyone taken', () => {
    const got = inviteCandidates(
      [
        member('a', 'Amy'),
        member('b', 'Bob', { deactivated_at: '2026-01-01T00:00:00Z' }),
        member('c', 'Cem'),
      ],
      ['c'],
      ''
    );
    expect(got.map((m) => m.user_id)).toEqual(['a']);
  });

  it('searches name and email', () => {
    const members = [
      member('a', 'Amy', { email: 'amy@x.test' }),
      member('b', 'Bob', { email: 'rob@y.test' }),
    ];
    expect(inviteCandidates(members, [], 'BOB').map((m) => m.user_id)).toEqual([
      'b',
    ]);
    expect(
      inviteCandidates(members, [], 'y.test').map((m) => m.user_id)
    ).toEqual(['b']);
  });
});
