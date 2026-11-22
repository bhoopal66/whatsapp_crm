import { describe, expect, it } from 'vitest';
import { formatPhoneDisplay, phoneForCopy } from './phone-format';

describe('formatPhoneDisplay', () => {
  it('formats UAE mobiles and landlines', () => {
    expect(formatPhoneDisplay('971501234401')).toBe('+971 50 123 4401');
    expect(formatPhoneDisplay('+971 50-123-4401')).toBe('+971 50 123 4401');
    expect(formatPhoneDisplay('00971501234401')).toBe('+971 50 123 4401');
    expect(formatPhoneDisplay('97143123456')).toBe('+971 4 312 3456');
  });

  it('drops a trunk 0 typed after the country code', () => {
    expect(formatPhoneDisplay('+971 050 123 4401')).toBe('+971 50 123 4401');
  });

  it('formats India, UK and US/Canada', () => {
    expect(formatPhoneDisplay('919876543210')).toBe('+91 98765 43210');
    expect(formatPhoneDisplay('+447911123456')).toBe('+44 7911 123456');
    expect(formatPhoneDisplay('14155552671')).toBe('+1 415 555 2671');
  });

  it('groups other known countries generically', () => {
    expect(formatPhoneDisplay('+37063949836')).toBe('+370 639 498 36');
  });

  it('shows an unknown country code as typed', () => {
    expect(formatPhoneDisplay('+999123456789')).toBe('+999123456789');
  });

  it('leaves short, local and garbage input alone', () => {
    expect(formatPhoneDisplay('12345')).toBe('12345');
    expect(formatPhoneDisplay('0501234401')).toBe('0501234401');
    expect(formatPhoneDisplay('  n/a ')).toBe('n/a');
    expect(formatPhoneDisplay('')).toBe('');
    expect(formatPhoneDisplay(null)).toBe('');
    expect(formatPhoneDisplay(undefined)).toBe('');
    expect(formatPhoneDisplay('+1234567890123456789')).toBe(
      '+1234567890123456789'
    );
  });
});

describe('phoneForCopy', () => {
  it('gives the raw international number', () => {
    expect(phoneForCopy('971 50 123 4401')).toBe('+971501234401');
    expect(phoneForCopy('+971-50-123-4401')).toBe('+971501234401');
    expect(phoneForCopy('00447911123456')).toBe('+447911123456');
  });
  it('returns local or short numbers unchanged', () => {
    expect(phoneForCopy('0501234401')).toBe('0501234401');
    expect(phoneForCopy('12345')).toBe('12345');
  });
});
