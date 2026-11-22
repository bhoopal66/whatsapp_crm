import { describe, expect, it } from 'vitest';
import { withParams } from './url-state';

describe('withParams', () => {
  it('sets, replaces and removes keys, keeping the others', () => {
    expect(withParams('?c=1', { sort: 'name', dir: 'asc' })).toBe(
      '?c=1&sort=name&dir=asc'
    );
    expect(withParams('?sort=name&dir=asc', { dir: 'desc' })).toBe(
      '?sort=name&dir=desc'
    );
    expect(withParams('?sort=name', { sort: null })).toBe('');
    expect(withParams('', { sort: '' })).toBe('');
  });
});
