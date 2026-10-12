import { describe, expect, it } from 'vitest';

import { pickActiveProfile } from './active-profile';

describe('pickActiveProfile', () => {
  it('takes the active row, wherever it sits', () => {
    const rows = [
      { account_id: 'credit', is_active: false },
      { account_id: 'trafeeq', is_active: true },
    ];
    expect(pickActiveProfile(rows)?.account_id).toBe('trafeeq');
    expect(pickActiveProfile([...rows].reverse())?.account_id).toBe('trafeeq');
  });

  it('takes the only row on a database without 083 (no is_active column)', () => {
    expect(
      pickActiveProfile<{ account_id: string; is_active?: boolean }>([
        { account_id: 'only' },
      ])?.account_id
    ).toBe('only');
  });

  it('falls back to the first row when none is marked active', () => {
    const rows = [
      { account_id: 'a', is_active: false },
      { account_id: 'b', is_active: false },
    ];
    expect(pickActiveProfile(rows)?.account_id).toBe('a');
  });

  it('is null for no rows', () => {
    expect(pickActiveProfile([])).toBeNull();
    expect(pickActiveProfile(null)).toBeNull();
    expect(pickActiveProfile(undefined)).toBeNull();
  });
});
