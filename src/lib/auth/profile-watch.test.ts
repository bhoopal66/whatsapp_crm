import { describe, expect, it } from 'vitest';

import {
  compareProfile,
  PROFILE_CHECK_EVERY_MS,
  profileCheckDue,
  watchedActiveRow,
} from './profile-watch';

describe('profileCheckDue', () => {
  const at = (over: Partial<Parameters<typeof profileCheckDue>[0]>) =>
    profileCheckDue({
      trigger: 'visibility',
      visible: true,
      lastCheckAt: 1_000,
      now: 1_000,
      ...over,
    });

  it('is due when the tab is shown, once per 120 s', () => {
    expect(PROFILE_CHECK_EVERY_MS).toBe(120_000);
    expect(at({ lastCheckAt: null })).toBe(true);
    expect(at({ now: 120_999 })).toBe(false);
    expect(at({ now: 121_000 })).toBe(true);
  });

  it('is not due when the tab is hidden', () => {
    expect(at({ lastCheckAt: null, visible: false })).toBe(false);
  });

  it('is always due on a refreshed token', () => {
    expect(at({ trigger: 'token', visible: false })).toBe(true);
  });
});

const ROW = {
  account_id: 'acct-1' as string | null,
  account_role: 'agent',
  is_active: true as boolean | null,
  deactivated_at: null as string | null,
  department: 'sales',
};

describe('watchedActiveRow', () => {
  const read = (data: (typeof ROW)[] | null, error: unknown = null) =>
    watchedActiveRow({ data, error });

  it('is the one active row', () => {
    expect(read([{ ...ROW, is_active: false }, ROW])).toBe(ROW);
  });

  it('is nothing on a failed or an empty read', () => {
    expect(read([ROW], { message: 'timeout' })).toBeNull();
    expect(read([])).toBeNull();
    expect(read(null)).toBeNull();
  });

  it('is never a guess', () => {
    expect(read([{ ...ROW, is_active: false }])).toBeNull();
    expect(read([{ ...ROW, is_active: null }])).toBeNull();
    expect(read([ROW, { ...ROW, account_id: 'acct-2' }])).toBeNull();
    expect(read([{ ...ROW, account_id: null }])).toBeNull();
  });
});

describe('compareProfile', () => {
  const SHOWN = {
    account_id: 'acct-1',
    account_role: 'agent',
    department: 'sales',
  } as const;
  const compare = (over: Partial<Parameters<typeof compareProfile>[1]>) =>
    compareProfile(SHOWN, { ...ROW, ...over });

  it('is none for the row this tab shows', () => {
    expect(compare({})).toEqual({ kind: 'none' });
  });

  it('is switched for another account, with the role held there', () => {
    expect(compare({ account_id: 'acct-2', account_role: 'owner' })).toEqual({
      kind: 'switched',
      role: 'owner',
    });
    expect(compare({ account_id: 'acct-2', account_role: 'new' })).toEqual({
      kind: 'switched',
      role: null,
    });
  });

  it('is deactivated only for the workspace this tab shows', () => {
    const deactivated_at = '2026-11-24T10:00:00Z';
    expect(compare({ deactivated_at })).toEqual({ kind: 'deactivated' });
    expect(compare({ deactivated_at, account_id: 'acct-2' }).kind).toBe(
      'switched'
    );
  });

  it('is update for another role or department', () => {
    expect(compare({ account_role: 'team_leader' })).toEqual({
      kind: 'update',
      role: 'team_leader',
      department: 'sales',
    });
    expect(compare({ department: 'hr' })).toEqual({
      kind: 'update',
      role: 'agent',
      department: 'hr',
    });
  });

  it('is none for a role or department this build does not know', () => {
    expect(compare({ account_role: 'new', department: 'hr' }).kind).toBe(
      'none'
    );
    expect(compare({ account_role: 'owner', department: 'new' }).kind).toBe(
      'none'
    );
    expect(compare({ department: null }).kind).toBe('none');
  });

  it('keeps the department of a database without the column', () => {
    expect(compare({ department: undefined }).kind).toBe('none');
  });
});
