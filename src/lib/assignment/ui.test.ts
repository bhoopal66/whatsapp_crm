import { describe, expect, it } from 'vitest';

import {
  assignmentErrorOf,
  formatMemberLoad,
  isAtLimit,
  knownAssignmentError,
  loadsByUser,
  parseChatLimit,
  rotationPeople,
} from './ui';

describe('formatMemberLoad', () => {
  it('shows open/limit while limits are on', () => {
    expect(
      formatMemberLoad({ userId: 'u', openCount: 12, chatLimit: 30 })
    ).toBe('12/30');
  });

  it('shows the open count alone while limits are off', () => {
    expect(
      formatMemberLoad({ userId: 'u', openCount: 12, chatLimit: null })
    ).toBe('12');
    expect(
      formatMemberLoad({ userId: 'u', openCount: 0, chatLimit: null })
    ).toBe('0');
  });

  it('shows nothing without a row', () => {
    expect(formatMemberLoad(undefined)).toBeNull();
    expect(formatMemberLoad(null)).toBeNull();
  });
});

describe('isAtLimit', () => {
  it('is true only at or over a limit that is on', () => {
    expect(isAtLimit({ userId: 'u', openCount: 30, chatLimit: 30 })).toBe(true);
    expect(isAtLimit({ userId: 'u', openCount: 29, chatLimit: 30 })).toBe(
      false
    );
    expect(isAtLimit({ userId: 'u', openCount: 99, chatLimit: null })).toBe(
      false
    );
    expect(isAtLimit(undefined)).toBe(false);
  });
});

describe('loadsByUser', () => {
  it('keys loads by user id', () => {
    const m = loadsByUser([{ userId: 'a', openCount: 1, chatLimit: null }]);
    expect(m.get('a')?.openCount).toBe(1);
    expect(m.get('b')).toBeUndefined();
  });
});

describe('rotationPeople', () => {
  const members = [
    { user_id: 'o', full_name: 'Owner', role: 'owner', deactivated_at: null },
    { user_id: 'a', full_name: 'Zed', role: 'agent', deactivated_at: null },
    {
      user_id: 'l',
      full_name: 'Amal',
      role: 'team_leader',
      deactivated_at: null,
    },
    { user_id: 'v', full_name: 'Viewer', role: 'viewer', deactivated_at: null },
    {
      user_id: 'd',
      full_name: 'Gone',
      role: 'agent',
      deactivated_at: '2026-01-01',
    },
    {
      user_id: 'g',
      full_name: 'Guest',
      role: 'bank_guest',
      deactivated_at: null,
    },
  ];

  it('offers live agents and team leaders, by name', () => {
    expect(rotationPeople(members)).toEqual([
      { userId: 'l', name: 'Amal' },
      { userId: 'a', name: 'Zed' },
    ]);
  });

  it('keeps a saved person listed whatever they are now', () => {
    expect(rotationPeople(members, ['d']).map((p) => p.userId)).toEqual([
      'l',
      'd',
      'a',
    ]);
  });

  it('reads account_role and falls back to email for the name', () => {
    expect(
      rotationPeople([
        {
          user_id: 'x',
          full_name: ' ',
          email: 'x@ex.com',
          account_role: 'agent',
        },
      ])
    ).toEqual([{ userId: 'x', name: 'x@ex.com' }]);
  });
});

describe('parseChatLimit', () => {
  it('accepts whole numbers 1-500', () => {
    expect(parseChatLimit('30')).toBe(30);
    expect(parseChatLimit(' 1 ')).toBe(1);
    expect(parseChatLimit(500)).toBe(500);
  });

  it('refuses anything else', () => {
    for (const v of ['0', '501', '', '3.5', '-2', 'abc', '1e2'])
      expect(parseChatLimit(v)).toBeNull();
  });
});

describe('assignmentErrorOf', () => {
  it('words the SQL hints', () => {
    expect(assignmentErrorOf('bad_limit')).toEqual({
      error: 'bad_limit',
      status: 422,
    });
    expect(assignmentErrorOf('pool_member_invalid')?.status).toBe(422);
    expect(assignmentErrorOf('pool_too_large')?.status).toBe(422);
    expect(assignmentErrorOf('no_such_member')).toEqual({
      error: 'no_such_member',
      status: 404,
    });
  });

  it('maps a refused caller and a missing migration', () => {
    expect(assignmentErrorOf('42501')).toEqual({
      error: 'not_allowed',
      status: 403,
    });
    expect(assignmentErrorOf('PGRST202')?.error).toBe('not_available');
  });

  it('leaves anything else unworded', () => {
    expect(assignmentErrorOf('XX000')).toBeNull();
    expect(assignmentErrorOf(null)).toBeNull();
  });
});

describe('knownAssignmentError', () => {
  it('accepts only the listed codes', () => {
    expect(knownAssignmentError('bad_limit')).toBe('bad_limit');
    expect(knownAssignmentError('nope')).toBeNull();
    expect(knownAssignmentError(3)).toBeNull();
  });
});
