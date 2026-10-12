import { describe, expect, it } from 'vitest';

import { listedPeople, memberRow } from './members';
import type { RosterEntry, StaffParticipant } from './reads';

const base: StaffParticipant = {
  id: 'p1',
  displayName: 'Omar',
  role: 'customer',
  status: 'joined',
  joinedAt: null,
  leftAt: null,
  bankCode: null,
  expected: true,
  consent: true,
  phone: '+971 XXXXXXX67',
  invitedAt: null,
};

describe('memberRow', () => {
  it('shows a consenting customer with consent and status badges', () => {
    expect(memberRow(base, true)).toEqual({
      role: 'customer',
      bank: null,
      phone: '+971 XXXXXXX67',
      badges: ['consent', 'joined'],
      removable: true,
    });
  });

  it('marks a bank officer as a guest of their bank', () => {
    const row = memberRow(
      {
        ...base,
        role: 'bank_guest',
        bankCode: 'MASHREQ',
        consent: false,
        status: 'pending_approval',
      },
      true
    );
    expect(row).toMatchObject({
      role: 'bank',
      bank: 'MASHREQ',
      badges: ['guest', 'pending'],
      removable: false,
    });
  });

  it('lets only a manager remove, and only someone in the group', () => {
    expect(memberRow(base, false).removable).toBe(false);
    expect(memberRow({ ...base, status: 'invited' }, true).removable).toBe(
      false
    );
    expect(memberRow({ ...base, role: 'business' }, true).removable).toBe(
      false
    );
  });

  it('draws a guest viewer’s roster entry without phone or consent', () => {
    const roster: RosterEntry = {
      id: 'p2',
      displayName: 'Lina',
      role: 'partner',
      status: 'left',
      joinedAt: null,
      leftAt: null,
    };
    expect(memberRow(roster, false)).toEqual({
      role: 'partner',
      bank: null,
      phone: null,
      badges: ['left'],
      removable: false,
    });
  });

  it('leaves our own number out of the people list', () => {
    expect(
      listedPeople([base, { ...base, id: 'b', role: 'business' }]).map(
        (p) => p.id
      )
    ).toEqual(['p1']);
  });
});
