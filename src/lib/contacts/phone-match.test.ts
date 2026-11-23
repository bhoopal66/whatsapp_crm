import { describe, expect, it } from 'vitest';
import { isLocalPhone, phonesMatch } from './phone-match';

describe('phonesMatch', () => {
  it('returns true for exact digit matches', () => {
    expect(phonesMatch('+37063949836', '37063949836')).toBe(true);
  });

  it.each([
    ['370063949836', '37063949836'],
    ['+971 050 455 5843', '971504555843'],
    ['00971 50 455 5843', '971504555843'],
    ['+44 (0)7700 900123', '447700900123'],
    // Fits no plan, so only the trunk 0 itself can be compared.
    ['9710123456789012', '971123456789012'],
  ])('matches the trunk-0 form of the same country: %s = %s', (a, b) => {
    expect(phonesMatch(a, b)).toBe(true);
    expect(phonesMatch(b, a)).toBe(true);
  });

  it.each([
    ['+971501234567', '+966501234567'],
    ['+971501234567', '447501234567'],
    ['971501234567', '919801234567'],
    // Italy: the 0 belongs to the number.
    ['+39 06 1234 5678', '39612345678'],
    // Not a trunk 0: it sits inside the country code.
    ['9071504555843', '971504555843'],
  ])('keeps two international numbers apart: %s / %s', (a, b) => {
    expect(phonesMatch(a, b)).toBe(false);
    expect(phonesMatch(b, a)).toBe(false);
  });

  it('rejects mismatched numbers', () => {
    expect(phonesMatch('+37063949836', '+37063949837')).toBe(false);
  });

  it('rejects very short inputs that would false-positive on tail match', () => {
    // Only 7 digits — the last-8 fallback is gated to len>=8 on both
    // sides to avoid declaring "12345" and "67890-12345" a match.
    expect(phonesMatch('1234567', '1234567')).toBe(true);
    expect(phonesMatch('1234567', '9991234567')).toBe(false);
  });

  it('compares a number without its country code by its last 8 digits', () => {
    expect(phonesMatch('050 455 5843', '971504555843')).toBe(true);
    expect(phonesMatch('50 455 5843', '971504555843')).toBe(true);
    expect(phonesMatch('98765 43210', '919876543210')).toBe(true);
  });

  it('ignores formatting noise on both sides', () => {
    expect(phonesMatch('+370 6 394 9836', '37063949836')).toBe(true);
    expect(phonesMatch('(415) 555-1212', '+1 415-555-1212')).toBe(true);
  });
});

describe('isLocalPhone', () => {
  it.each(['050 455 5843', '504555843', '04 123 4567', '98765 43210'])(
    '%s has no country code',
    (phone) => expect(isLocalPhone(phone)).toBe(true)
  );
  it.each(['971504555843', '00971504555843', '+65 9123 4567', '97150455584'])(
    '%s has one',
    (phone) => expect(isLocalPhone(phone)).toBe(false)
  );
});
