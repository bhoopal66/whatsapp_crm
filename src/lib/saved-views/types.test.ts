import { describe, expect, it } from 'vitest';
import {
  canChangeView,
  cleanViewName,
  sortViews,
  toSavedView,
  type SavedView,
} from './types';

const v = (o: Partial<SavedView>): SavedView => ({
  id: 'i',
  screen: 'inbox',
  name: 'n',
  shared: false,
  ownerId: 'me',
  filters: {},
  updatedAt: '',
  ...o,
});

describe('saved view helpers', () => {
  it('cleans names', () => {
    expect(cleanViewName('  Hot  ')).toBe('Hot');
    expect(cleanViewName('   ')).toBeNull();
    expect(cleanViewName('x'.repeat(61))).toBeNull();
  });
  it('ignores rows of unknown screens', () => {
    expect(
      toSavedView({
        id: '1',
        screen: 'nope',
        name: 'a',
        shared: false,
        owner_user_id: 'u',
        filters: {},
        updated_at: '',
      })
    ).toBeNull();
  });
  it('lists personal before shared, then by name', () => {
    const out = sortViews(
      [
        v({ id: '1', name: 'b', shared: true }),
        v({ id: '2', name: 'z' }),
        v({ id: '3', name: 'a' }),
      ],
      'me'
    );
    expect(out.map((x) => x.id)).toEqual(['3', '2', '1']);
  });
  it('lets owners and admins (for shared) change', () => {
    expect(canChangeView(v({}), 'me', false)).toBe(true);
    expect(canChangeView(v({ ownerId: 'x' }), 'me', true)).toBe(false);
    expect(canChangeView(v({ ownerId: 'x', shared: true }), 'me', true)).toBe(
      true
    );
  });
});
