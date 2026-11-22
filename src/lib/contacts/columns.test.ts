import { describe, expect, it } from 'vitest';
import {
  columnPrefsKey,
  DEFAULT_COLUMN_PREFS,
  OPTIONAL_COLUMNS,
  parseColumnPrefs,
  serializeColumnPrefs,
  toggleHidden,
  visibleColumns,
} from './columns';

describe('parseColumnPrefs', () => {
  it('round-trips', () => {
    const prefs = { hidden: ['email' as const], hideEmpty: true };
    expect(parseColumnPrefs(serializeColumnPrefs(prefs))).toEqual(prefs);
  });
  it('is defensive about old and broken values', () => {
    expect(parseColumnPrefs('{nope')).toEqual(DEFAULT_COLUMN_PREFS);
    expect(parseColumnPrefs(null)).toEqual(DEFAULT_COLUMN_PREFS);
    expect(parseColumnPrefs(7)).toEqual(DEFAULT_COLUMN_PREFS);
    expect(
      parseColumnPrefs({
        hidden: ['email', 'email', 'name', 'ghost', 4],
        hideEmpty: 'yes',
      })
    ).toEqual({ hidden: ['email'], hideEmpty: false });
  });
});

describe('visibleColumns', () => {
  it('shows everything by default', () => {
    expect(visibleColumns(DEFAULT_COLUMN_PREFS, []).size).toBe(
      OPTIONAL_COLUMNS.length
    );
  });
  it('hides what the user hid', () => {
    const v = visibleColumns(toggleHidden(DEFAULT_COLUMN_PREFS, 'company'), []);
    expect(v.has('company')).toBe(false);
    expect(v.has('email')).toBe(true);
  });
  it('hides columns with no value in the loaded rows', () => {
    const prefs = { hidden: [], hideEmpty: true };
    const v = visibleColumns(prefs, [
      { email: true, createdAt: true },
      { company: false, createdAt: true },
    ]);
    expect([...v].sort()).toEqual(['createdAt', 'email']);
  });
  it('keeps every column while no rows are loaded', () => {
    expect(visibleColumns({ hidden: [], hideEmpty: true }, []).size).toBe(
      OPTIONAL_COLUMNS.length
    );
  });
  it('toggles back', () => {
    const once = toggleHidden(DEFAULT_COLUMN_PREFS, 'owner');
    expect(toggleHidden(once, 'owner')).toEqual(DEFAULT_COLUMN_PREFS);
  });
});

describe('columnPrefsKey', () => {
  it('is per user', () => {
    expect(columnPrefsKey('u1')).not.toBe(columnPrefsKey('u2'));
    expect(columnPrefsKey(null)).toContain('anon');
  });
});
