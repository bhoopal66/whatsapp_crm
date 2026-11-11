import { describe, expect, it } from 'vitest';
import { phoneDigits, phoneSearchDigits } from './phone-search';

describe('phoneSearchDigits', () => {
  const stored = phoneDigits('+971 58 833 6503');

  it.each([
    ['588336503', '588336503'],
    ['0588336503', '588336503'],
    ['+971588336503', '971588336503'],
    ['00971588336503', '971588336503'],
    ['58 833 6503', '588336503'],
    ['+971 58-833-6503', '971588336503'],
  ])('reads %s as digits found in the stored phone', (term, digits) => {
    expect(phoneSearchDigits(term)).toBe(digits);
    expect(stored).toContain(digits);
  });

  it('is null for a name search', () => {
    expect(phoneSearchDigits('Elsa')).toBeNull();
    expect(phoneSearchDigits('Elsa 0588')).toBeNull();
    expect(phoneSearchDigits('علي 0588')).toBeNull();
  });

  it('is null under four digits', () => {
    expect(phoneSearchDigits('123')).toBeNull();
    expect(phoneSearchDigits('0123')).toBeNull();
    expect(phoneSearchDigits('+ 0')).toBeNull();
    expect(phoneSearchDigits('')).toBeNull();
  });
});

describe('phoneDigits', () => {
  it('keeps only digits', () => {
    expect(phoneDigits('+971 (58) 833-6503')).toBe('971588336503');
    expect(phoneDigits(null)).toBe('');
  });
});
