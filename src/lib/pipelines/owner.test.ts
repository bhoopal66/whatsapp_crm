import { describe, expect, it } from 'vitest';

import {
  assignableOwners,
  dealOwnerOrFilter,
  dealOwnerProfile,
  ownerFilterOptions,
  type DealPeopleInput,
  type PersonIds,
} from './owner';

// profiles.id and the auth user id differ, as they do in the database.
const me = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const mate = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const other = {
  id: '33333333-3333-4333-8333-333333333333',
  user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const members: PersonIds[] = [me, mate, other];

function input(
  role: DealPeopleInput<PersonIds>['role']
): DealPeopleInput<PersonIds> {
  return { role, me, members, ledUserIds: new Set([mate.user_id]) };
}

const keys = (opts: { key: string }[]) => opts.map((o) => o.key);

describe('dealOwnerProfile', () => {
  it('is the assignee, matched on profiles.id', () => {
    expect(
      dealOwnerProfile({ assigned_to: mate.id, user_id: me.user_id }, members)
    ).toBe(mate);
  });

  it('falls back to the creator, matched on the auth user id', () => {
    expect(
      dealOwnerProfile({ assigned_to: null, user_id: other.user_id }, members)
    ).toBe(other);
    expect(dealOwnerProfile({ user_id: me.user_id }, members)).toBe(me);
  });

  it('never matches an assignee on the creator column', () => {
    expect(
      dealOwnerProfile({ assigned_to: mate.user_id, user_id: me.user_id }, [
        mate,
      ])
    ).toBeNull();
  });
});

describe('dealOwnerOrFilter', () => {
  it('matches the assignee, or the creator of an unassigned deal', () => {
    expect(dealOwnerOrFilter(mate)).toBe(
      `assigned_to.eq.${mate.id},and(assigned_to.is.null,user_id.eq.${mate.user_id})`
    );
  });

  it('refuses ids that are not UUIDs', () => {
    expect(dealOwnerOrFilter({ id: 'x),id.neq.(0', user_id: me.user_id })).toBe(
      null
    );
    expect(dealOwnerOrFilter({ id: me.id, user_id: '' })).toBeNull();
  });
});

describe('ownerFilterOptions', () => {
  it.each(['owner', 'admin'] as const)(
    'offers %s Everyone, My deals and every other member',
    (role) => {
      expect(keys(ownerFilterOptions(input(role)))).toEqual([
        'everyone',
        'mine',
        mate.id,
        other.id,
      ]);
    }
  );

  it('offers a team leader My team, My deals and only their teammates', () => {
    const opts = ownerFilterOptions(input('team_leader'));
    expect(keys(opts)).toEqual(['team', 'mine', mate.id]);
    expect(opts[1]).toMatchObject({ kind: 'mine', person: me });
  });

  it.each(['agent', 'viewer', null] as const)('offers %s no picker', (role) => {
    expect(ownerFilterOptions(input(role))).toEqual([]);
  });

  it('offers nothing before the profile has loaded', () => {
    expect(ownerFilterOptions({ ...input('admin'), me: null })).toEqual([]);
  });
});

describe('assignableOwners', () => {
  it('lets an admin give a deal to anyone', () => {
    expect(assignableOwners(input('admin'))).toEqual(members);
  });

  it('lets a team leader give a deal to themselves and their teammates', () => {
    expect(assignableOwners(input('team_leader'))).toEqual([me, mate]);
  });

  it.each(['agent', 'viewer'] as const)('keeps %s to themselves', (role) => {
    expect(assignableOwners(input(role))).toEqual([me]);
  });

  it('is empty without a role or a profile', () => {
    expect(assignableOwners(input(null))).toEqual([]);
    expect(assignableOwners({ ...input('agent'), me: null })).toEqual([]);
  });
});
