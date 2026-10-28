import { describe, expect, it } from 'vitest';

import { firstName, greetingKey } from './greeting';

describe('greetingKey', () => {
  it('splits the day at 5, 12 and 17', () => {
    expect(greetingKey(4)).toBe('evening');
    expect(greetingKey(5)).toBe('morning');
    expect(greetingKey(11)).toBe('morning');
    expect(greetingKey(12)).toBe('afternoon');
    expect(greetingKey(16)).toBe('afternoon');
    expect(greetingKey(17)).toBe('evening');
    expect(greetingKey(23)).toBe('evening');
  });
});

describe('firstName', () => {
  it('takes the first word of the name', () => {
    expect(firstName('  Sara  Al Mansoori ', 'x@y.ae')).toBe('Sara');
  });

  it('falls back to the email, then to nothing', () => {
    expect(firstName('', 'sara@taamul.ae')).toBe('sara');
    expect(firstName(null, null)).toBeNull();
    expect(firstName('   ', '@nothing')).toBeNull();
  });
});
