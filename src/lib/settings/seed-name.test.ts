import { describe, expect, it } from 'vitest';

import { seedFullName } from './seed-name';

describe('seedFullName', () => {
  it('seeds on the first load', () => {
    expect(seedFullName('', null, 'Sara')).toBe('Sara');
  });

  it('a new profile object with the same name keeps what is being typed', () => {
    expect(seedFullName('Sara Al', 'Sara', 'Sara')).toBe('Sara Al');
  });

  it('a changed stored name replaces an untouched field', () => {
    expect(seedFullName('Sara', 'Sara', 'Sarah')).toBe('Sarah');
  });

  it('a changed stored name never overwrites a name being typed', () => {
    expect(seedFullName('Sara Al', 'Sara', 'Sarah')).toBe('Sara Al');
  });
});
