import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import type { ChatPerson } from '@/lib/chat/types';

import { addPeopleFailure } from './people';
import {
  ADD_PEOPLE_ERRORS,
  addPeopleCandidates,
  addPeopleErrorKey,
  addPeopleOptions,
} from './people-ui';

const person = (userId: string, role: string): ChatPerson => ({
  userId,
  fullName: userId,
  avatarUrl: null,
  role,
  bankCode: role === 'bank_guest' ? 'ADCB' : null,
  presenceStatus: null,
  lastSeenAt: null,
});

describe('addPeopleOptions', () => {
  it('offers staff to any manager and a bank guest from team leader up', () => {
    const at = (role: 'agent' | 'team_leader' | 'admin' | 'owner') =>
      addPeopleOptions({ canManage: true, status: 'open', role });
    expect(at('agent')).toEqual({ staff: true, guest: false });
    expect(at('team_leader')).toEqual({ staff: true, guest: true });
    expect(at('admin')).toEqual({ staff: true, guest: true });
    expect(at('owner')).toEqual({ staff: true, guest: true });
  });

  it('offers nothing to someone who does not manage the room', () => {
    expect(
      addPeopleOptions({ canManage: false, status: 'open', role: 'owner' })
    ).toEqual({ staff: false, guest: false });
  });

  it('offers no bank guest without a role', () => {
    expect(
      addPeopleOptions({ canManage: true, status: 'open', role: null })
    ).toEqual({ staff: true, guest: false });
  });

  it('takes people while creating, open or suspended, not once failed or closing', () => {
    const on = (status: string) =>
      addPeopleOptions({ canManage: true, status, role: 'admin' }).staff;
    expect(['creating', 'open', 'suspended'].map(on)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['failed', 'closing', 'closed', 'unknown'].map(on)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('addPeopleCandidates', () => {
  const people = [
    person('a', 'agent'),
    person('B', 'viewer'),
    person('g1', 'bank_guest'),
    person('g2', 'bank_guest'),
  ];

  it('lists staff not yet in the channel, ignoring id case', () => {
    expect(
      addPeopleCandidates(people, [{ userId: 'b' }], 'staff').map(
        (p) => p.userId
      )
    ).toEqual(['a']);
  });

  it('lists bank guest logins not yet in the channel', () => {
    expect(
      addPeopleCandidates(people, [{ userId: 'g1' }], 'guest').map(
        (p) => p.userId
      )
    ).toEqual(['g2']);
  });
});

describe('addPeopleErrorKey', () => {
  it('keeps the codes the panel words and drops the rest', () => {
    expect(addPeopleErrorKey('no_bank_participant')).toBe(
      'no_bank_participant'
    );
    expect(addPeopleErrorKey('forbidden')).toBeNull();
    expect(addPeopleErrorKey(undefined)).toBeNull();
  });

  it('has a sentence for every code', () => {
    const words = en.Chat.rooms.people.error as Record<string, string>;
    for (const code of ADD_PEOPLE_ERRORS) {
      expect(words[code], code).toEqual(expect.any(String));
    }
  });

  it('covers every refusal the route turns into a specific code', () => {
    const refusals: [string, string][] = [
      ['42501', 'deal rooms: only a manager of this room can add people'],
      [
        '42501',
        'deal rooms: only a team leader or an admin can add a bank guest',
      ],
      ['22023', 'deal rooms: the room is closed'],
      ['22023', 'deal rooms: 0000 is not staff of this workspace'],
      [
        '22023',
        'deal rooms: that person is not a bank guest of this workspace',
      ],
      ['22023', 'deal rooms: this room has no approved ADCB participant'],
      ['22023', 'deal rooms: ADCB officers cannot join customer groups'],
    ];
    for (const [code, message] of refusals) {
      const f = addPeopleFailure({ code, message });
      expect(addPeopleErrorKey(f.code), message).toBe(f.code);
    }
  });
});
