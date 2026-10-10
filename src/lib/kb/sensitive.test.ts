import { describe, expect, it } from 'vitest';

import { EID, redact } from '@/lib/typesafe/redact';

import { containsSensitiveData } from './sensitive';

describe('containsSensitiveData', () => {
  it.each([
    ['an Emirates ID with dashes', 'my id is 784-1990-1234567-1'],
    ['an Emirates ID without dashes', 'EID 784199012345671 thanks'],
    ['an Arabic-Indic Emirates ID', 'هويتي ٧٨٤١٩٩٠١٢٣٤٥٦٧١'],
    ['a card number', 'card 4111 1111 1111 1111 exp 12/28'],
    ['an unspaced card number', '4111111111111111'],
    ['a UAE IBAN with spaces', 'IBAN AE07 0331 2345 6789 0123 456'],
    ['a foreign IBAN', 'GB82WEST12345698765432'],
  ])('flags %s', (_label, text) => {
    expect(containsSensitiveData(text)).toBe(true);
  });

  it.each([
    ['a UAE mobile', 'call me on +971 50 123 4567'],
    ['a 00971 number', '00971501234567'],
    // Luhn-valid as 14 digits: only the phone masking keeps it out.
    ['a Luhn-valid 00971 number', 'my number is 00971501234563'],
    ['a spaced Luhn-valid 00971 number', '00971 50 123 4563'],
    ['an amount', 'I can invest AED 250,000'],
    ['a trade licence number', 'trade licence 1234567'],
    ['a date', 'meet on 27/09/2026 or 2026-10-01 at 10:30'],
    ['a card that fails Luhn', '4111 1111 1111 1112'],
    ['plain text', 'What are your fees?'],
  ])('does not flag %s', (_label, text) => {
    expect(containsSensitiveData(text)).toBe(false);
  });

  it('leaves the shared patterns usable by redact()', () => {
    containsSensitiveData('784-1990-1234567-1');
    expect(EID.lastIndex).toBe(0);
    expect(redact('784-1990-1234567-1').text).toBe('[EID]');
  });
});
