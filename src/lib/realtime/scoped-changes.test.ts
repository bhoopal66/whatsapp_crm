import { describe, expect, it } from 'vitest';

import { eqUuidFilter, scopedChangeBindings } from './scoped-changes';

const ACCOUNT = '0b6f1c9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';

describe('eqUuidFilter', () => {
  it('builds the PostgREST-style equality filter', () => {
    expect(eqUuidFilter('account_id', ACCOUNT)).toBe(
      `account_id=eq.${ACCOUNT}`
    );
  });

  it('is null while the value is unknown', () => {
    expect(eqUuidFilter('account_id', null)).toBeNull();
    expect(eqUuidFilter('account_id', undefined)).toBeNull();
    expect(eqUuidFilter('account_id', '')).toBeNull();
  });

  it('refuses anything that is not a UUID, so it cannot rewrite the filter', () => {
    expect(eqUuidFilter('account_id', `${ACCOUNT},id=gt.0`)).toBeNull();
    expect(eqUuidFilter('account_id', 'acct-1')).toBeNull();
  });
});

describe('scopedChangeBindings', () => {
  it('filters INSERT and UPDATE and leaves DELETE unfiltered', () => {
    expect(
      scopedChangeBindings('conversations', 'account_id', ACCOUNT)
    ).toEqual([
      {
        event: 'INSERT',
        schema: 'public',
        table: 'conversations',
        filter: `account_id=eq.${ACCOUNT}`,
      },
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversations',
        filter: `account_id=eq.${ACCOUNT}`,
      },
      { event: 'DELETE', schema: 'public', table: 'conversations' },
    ]);
  });

  it('never yields an unfiltered INSERT or UPDATE binding', () => {
    for (const value of [ACCOUNT, null, undefined, '', 'x']) {
      const bindings = scopedChangeBindings('call_live', 'account_id', value);
      for (const b of bindings ?? []) {
        if (b.event !== 'DELETE') expect(b.filter).toBeTruthy();
      }
    }
  });

  it('is null while the scope is unknown, so the caller does not subscribe', () => {
    expect(scopedChangeBindings('notifications', 'user_id', null)).toBeNull();
    expect(scopedChangeBindings('notifications', 'user_id', 'nope')).toBeNull();
  });
});
