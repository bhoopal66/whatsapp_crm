import { describe, expect, it } from 'vitest';

import { EID, redact } from '@/lib/typesafe/redact';

import { containsSensitiveData, sensitiveKinds } from './sensitive';

const FLAGGED: [string, string][] = [
  ['an Emirates ID with dashes', 'my id is 784-1990-1234567-1'],
  ['an Emirates ID without dashes', 'EID 784199012345671 thanks'],
  ['an Arabic-Indic Emirates ID', 'هويتي ٧٨٤١٩٩٠١٢٣٤٥٦٧١'],
  ['a card number', 'card 4111 1111 1111 1111 exp 12/28'],
  ['an unspaced card number', '4111111111111111'],
  ['a UAE IBAN with spaces', 'IBAN AE07 0331 2345 6789 0123 456'],
  ['a UAE IBAN without spaces', 'AE070331234567890123456'],
  ['a lower-case UAE IBAN', 'my iban ae07 0331 2345 6789 0123 456 thanks'],
  ['a foreign IBAN', 'GB82WEST12345698765432'],
  ['a grouped GB IBAN', 'GB82 WEST 1234 5698 7654 32'],
  [
    'a dashed IBAN mid-sentence',
    'send to DE89-3704-0044-0532-0130-00 and confirm',
  ],
  ['an Omani IBAN', 'OM810180000001299123456'],
  ['an IBAN with a double space', 'AE07  0331 2345 6789 0123 456'],
  ['an IBAN with a non-breaking space', 'AE07\u00a00331 2345 6789 0123 456'],
  ['a space after the country code', 'AE 07 0331 2345 6789 0123 456'],
  ['irregular grouping', 'AE07033123456789 0123456'],
];

const NOT_FLAGGED: [string, string][] = [
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
  // Shaped like IBANs only if characters join across words, or not a
  // real IBAN at all (unknown country, wrong length, bad checksum).
  ['amounts in a sentence', 'my salary is dh15000 and i need 300000 loan'],
  ['a loan reference', 'ref LN20240012345 status?'],
  ['a grouped reference', 'Ref AB12 3456 7890 please check'],
  ['an IBAN with a bad checksum', 'AE08 0331 2345 6789 0123 456'],
  ['an IBAN of the wrong length', 'GB82 WEST 1234 5698 7654 3'],
  ['an IBAN running on into a longer word', 'AE070331234567890123456789'],
  ['prose after a country code', 'we are at 20 Main Street opposite the mall'],
];

describe('containsSensitiveData', () => {
  it.each(FLAGGED)('flags %s', (_label, text) => {
    expect(containsSensitiveData(text)).toBe(true);
  });

  it.each(NOT_FLAGGED)('does not flag %s', (_label, text) => {
    expect(containsSensitiveData(text)).toBe(false);
  });

  it('leaves the shared patterns usable by redact()', () => {
    containsSensitiveData('784-1990-1234567-1');
    expect(EID.lastIndex).toBe(0);
    expect(redact('784-1990-1234567-1').text).toBe('[EID]');
  });
});

describe('sensitiveKinds', () => {
  it('agrees with containsSensitiveData on every case above', () => {
    for (const [, text] of [...FLAGGED, ...NOT_FLAGGED]) {
      expect(containsSensitiveData(text)).toBe(sensitiveKinds(text).length > 0);
    }
    expect(FLAGGED.every(([, t]) => sensitiveKinds(t).length > 0)).toBe(true);
    expect(NOT_FLAGGED.every(([, t]) => sensitiveKinds(t).length === 0)).toBe(
      true
    );
  });

  it('labels an Emirates ID, and not also a card', () => {
    // 15 digits, Luhn-valid: without the second pass it would be a card.
    expect(sensitiveKinds('784-1990-1234567-1')).toEqual(['emirates_id']);
  });

  it('labels a valid IBAN, and not also a card', () => {
    expect(sensitiveKinds('IBAN AE07 0331 2345 6789 0123 456')).toEqual([
      'iban',
    ]);
    expect(sensitiveKinds('GB82WEST12345698765432')).toEqual(['iban']);
  });

  it('labels a card plus an IBAN as both, in order', () => {
    expect(
      sensitiveKinds(
        'card 4111 1111 1111 1111 and AE07 0331 2345 6789 0123 456'
      )
    ).toEqual(['card', 'iban']);
  });

  it('labels a card on its own', () => {
    expect(sensitiveKinds('card 4111 1111 1111 1111')).toEqual(['card']);
  });

  it('reads Arabic-Indic digits', () => {
    expect(sensitiveKinds('هويتي ٧٨٤١٩٩٠١٢٣٤٥٦٧١')).toEqual(['emirates_id']);
    expect(sensitiveKinds('٤١١١ ١١١١ ١١١١ ١١١١')).toEqual(['card']);
  });
});

describe('passport numbers', () => {
  it.each([
    'passport no. A1234567',
    'Passport number is AB1234567',
    'جواز سفر رقم A1234567',
  ])('sees %s', (t) => expect(containsSensitiveData(t)).toBe(true));
  it.each([
    'passport copy attached, salary 25000',
    'passport ready, Dh1500000',
    'passport Dh1500000',
    'my passport and visa expire 01/02/2027',
    'ref A1234567',
    'passport of company FZ1234567',
  ])('leaves %s', (t) => expect(containsSensitiveData(t)).toBe(false));
});
