import { describe, expect, it } from 'vitest';

import {
  handoverReceivers,
  leftWorkByPerson,
  parseHandoverKinds,
  parseWorkCounts,
  workTotal,
  type HandoverPerson,
} from './member-handover';

describe('parseWorkCounts', () => {
  it('reads counts and takes anything else as nothing', () => {
    expect(parseWorkCounts({ chats: 3, tasks: '2', deals: -1 })).toEqual({
      chats: 3,
      tasks: 0,
      deals: 0,
      contacts: 0,
    });
    expect(workTotal(parseWorkCounts(null))).toBe(0);
    expect(workTotal(parseWorkCounts({ chats: 3, contacts: 2 }))).toBe(5);
  });
});

describe('leftWorkByPerson', () => {
  it('keeps the people who hold something, by id', () => {
    const map = leftWorkByPerson({
      members: [
        { userId: 'u1', chats: 90, tasks: 52, deals: 0, contacts: 0 },
        { userId: 'u2', chats: 0, tasks: 0, deals: 0, contacts: 0 },
        { chats: 4 },
        null,
      ],
    });
    expect([...map.keys()]).toEqual(['u1']);
    expect(map.get('u1')).toMatchObject({ chats: 90, tasks: 52 });
  });

  it('is empty for a malformed answer', () => {
    for (const bad of [null, {}, { members: 'x' }, []])
      expect(leftWorkByPerson(bad).size).toBe(0);
  });
});

describe('handoverReceivers', () => {
  const person = (
    user_id: string,
    over: Partial<HandoverPerson> = {}
  ): HandoverPerson => ({
    user_id,
    name: user_id,
    role: 'agent',
    deactivated_at: null,
    ...over,
  });

  it('offers live staff but the leaver, by name', () => {
    const people = [
      person('zed'),
      person('leaver'),
      person('amy', { role: 'team_leader' }),
      person('gone', { deactivated_at: '2026-11-01T00:00:00Z' }),
      person('viewer', { role: 'viewer' }),
      person('guest', { role: 'bank_guest' }),
      person('owner', { role: 'owner' }),
    ];
    expect(handoverReceivers(people, 'leaver').map((p) => p.user_id)).toEqual([
      'amy',
      'owner',
      'zed',
    ]);
  });
});

describe('parseHandoverKinds', () => {
  it('takes a non-empty list of known kinds, once each', () => {
    expect(parseHandoverKinds(['tasks', 'chats', 'tasks'])).toEqual([
      'chats',
      'tasks',
    ]);
    for (const bad of [[], null, 'chats', ['cases'], [null]])
      expect(parseHandoverKinds(bad)).toBeNull();
  });
});
