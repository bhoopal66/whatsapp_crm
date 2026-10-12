import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';
import type { AccountMember } from '@/types';

import { staffOnly } from './members';

function member(user_id: string, role: AccountRole): AccountMember {
  return {
    user_id,
    full_name: user_id,
    email: null,
    avatar_url: null,
    role,
    joined_at: '2026-01-01T00:00:00Z',
    deactivated_at: null,
  };
}

describe('staffOnly', () => {
  it('drops a bank guest and keeps every staff role, in order', () => {
    const all = ACCOUNT_ROLES.map((role) => member(role, role));
    const kept = staffOnly(all).map((m) => m.role);

    expect(kept).not.toContain('bank_guest');
    expect(kept).toEqual(ACCOUNT_ROLES.filter((r) => r !== 'bank_guest'));
  });

  it('keeps a guest out of a mixed roster whoever sits around it', () => {
    const roster = [
      member('ana', 'agent'),
      { ...member('gus', 'bank_guest'), bank_code: 'ENBD' },
      member('bo', 'owner'),
    ];

    expect(staffOnly(roster).map((m) => m.user_id)).toEqual(['ana', 'bo']);
  });

  it('answers an empty roster with an empty list and leaves its input alone', () => {
    const roster = [member('gus', 'bank_guest'), member('ana', 'agent')];
    const before = [...roster];

    expect(staffOnly([])).toEqual([]);
    expect(staffOnly(roster)).toHaveLength(1);
    expect(roster).toEqual(before);
  });
});
