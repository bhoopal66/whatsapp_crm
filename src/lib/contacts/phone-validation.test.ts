import { describe, expect, it } from 'vitest';

import { dedupeByPhone } from './dedupe';
import { parseContactCsv } from './parse-contact-csv';
import {
  PHONE_EXAMPLE,
  partitionRowsByPhone,
  summarizeRejectedPhones,
  validateContactPhone,
  validatePhoneToSave,
  type PhoneValidationReason,
} from './phone-validation';

describe('validateContactPhone — accepted', () => {
  it.each([
    // UAE mobiles, every way people write them
    ['+971 50 123 4567', '971501234567'],
    ['971501234567', '971501234567'],
    ['+971-55-123-4567', '971551234567'],
    ['00971 50 123 4567', '971501234567'],
    // trunk 0 kept after the country code is removed
    ['+971 050 123 4567', '971501234567'],
    ['9710501234567', '971501234567'],
    ['+971 (0)58 184 2504', '971581842504'],
    // UAE landlines: 971 + 8 digits
    ['+971 4 123 4567', '97141234567'],
    ['+971 (0)2 123 4567', '97121234567'],
    // UAE shared-cost 600 and toll-free 800 numbers (banks run
    // WhatsApp on them)
    ['+971 600 599995', '971600599995'],
    ['+971 0600 599995', '971600599995'],
    ['+971 800 4444', '9718004444'],
    ['+971 800 300', '971800300'],
    // Lebanon, 10 and 11 digits — real contacts on the live account
    ['+961 3 123 456', '9613123456'],
    ['+961 71 123 456', '96171123456'],
    ['96131234567', '96131234567'],
    // Singapore, 10 digits, with or without the +
    ['+65 9123 4567', '6591234567'],
    ['6591234567', '6591234567'],
    // elsewhere: the number fits its country's plan
    ['+1 (415) 555-0123', '14155550123'],
    ['+44 7911 123456', '447911123456'],
    ['+86 138 0013 8000', '8613800138000'],
    ['919876543210', '919876543210'],
    ['+7 916 123 45 67', '79161234567'],
    ['+49 30 12345678', '493012345678'],
    ['+54 9 11 1234 5678', '5491112345678'],
    // WhatsApp's own +52 1 form of a Mexican mobile, and the plain one
    ['+52 1 55 1234 5678', '5215512345678'],
    ['+52 55 1234 5678', '525512345678'],
    ['  +971501234567  ', '971501234567'],
  ])('%s → %s', (raw, normalized) => {
    expect(validateContactPhone(raw)).toEqual({ ok: true, normalized });
  });
});

describe('validateContactPhone — trunk 0 after the country code', () => {
  it.each([
    // dialled only at home, never from abroad: dropped, as after +971
    ['+44 (0)7700 900123', '447700900123'],
    ['+44 07700 900123', '447700900123'],
    ['00 44 (0)20 7946 0958', '442079460958'],
    ['+966 050 123 4567', '966501234567'],
    ['+966 05 0123 4567', '966501234567'],
    ['+92 0300 1234567', '923001234567'],
    ['+63 0917 123 4567', '639171234567'],
    ['+20 010 1234 5678', '201012345678'],
    ['+961 03 123 456', '9613123456'],
    ['+91 098765 43210', '919876543210'],
    ['+250 0788 123 456', '250788123456'],
    // where national numbers really begin with 0, it stays
    ['+39 06 1234 5678', '390612345678'],
    ['+39 02 1234 5678', '390212345678'],
    ['+225 07 12 34 56 78', '2250712345678'],
  ])('%s → %s', (raw, normalized) => {
    expect(validateContactPhone(raw)).toEqual({ ok: true, normalized });
  });

  it('refuses a second 0', () => {
    expect(validateContactPhone('+44 00 7700 900123')).toMatchObject({
      ok: false,
      reason: 'invalid_number',
    });
  });
});

describe('validateContactPhone — separators and pasted text', () => {
  it.each([
    ['971.50.123.4567', '971501234567'],
    ['+971/50/1234567', '971501234567'],
    ['tel:+971501234567', '971501234567'],
    ['TEL:+971-50-123-4567', '971501234567'],
    // bidi marks around a number copied out of right-to-left text
    ['‪+971 50 123 4567‬', '971501234567'],
    ['‎+971 50 123 4567', '971501234567'],
    // Arabic letter mark, soft hyphen
    ['\u061c+971 50 123 4567', '971501234567'],
    ['+971 50\u00ad123\u00ad4567', '971501234567'],
    // no-break space, non-breaking hyphen, en dash, minus sign
    ['+971 50‑123‑4567', '971501234567'],
    ['+971 50 – 123 − 4567', '971501234567'],
  ])('%j → %s', (raw, normalized) => {
    expect(validateContactPhone(raw)).toEqual({ ok: true, normalized });
  });

  it('does not echo invisible marks back', () => {
    const result = validateContactPhone('‎050 123 4567');
    expect(result).toMatchObject({ ok: false, reason: 'missing_country_code' });
    if (!result.ok) expect(result.error).toContain('"050 123 4567"');
    expect(validateContactPhone('‎‏')).toMatchObject({
      reason: 'required',
    });
  });
});

describe('validateContactPhone — normalized output is stable', () => {
  it('validates every normalized number back to itself', () => {
    for (const raw of [
      '+971 050 123 4567',
      '+971 800 4444',
      '+44 (0)7700 900123',
      '+966 050 123 4567',
      '+961 03 123 456',
      '+39 06 1234 5678',
      '+52 1 55 1234 5678',
      '6591234567',
    ]) {
      const first = validateContactPhone(raw);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      expect(validateContactPhone(first.normalized)).toEqual(first);
      expect(validateContactPhone(`+${first.normalized}`)).toEqual(first);
    }
  });
});

describe('validateContactPhone — refused', () => {
  it.each<[string, PhoneValidationReason]>([
    ['', 'required'],
    ['   ', 'required'],
    // spreadsheet scientific notation (the 09-18 CSV import)
    ['9.71505E+11', 'scientific_notation'],
    ['9.71505e+11', 'scientific_notation'],
    ['9,71505E+11', 'scientific_notation'],
    ['9.7150E11', 'scientific_notation'],
    ['9.71501E+11.0', 'scientific_notation'],
    // a phone column exported as floats: the ".0" is not a digit
    ['919876543210.0', 'malformed'],
    ['447700900123.0', 'malformed'],
    ['+971501234567.00', 'malformed'],
    // a letter where a digit should be, or anything else that is not
    // a separator — no longer dropped to leave a different number
    ['+44 77OO 900123', 'malformed'],
    ['+971 5O 123 4567', 'malformed'],
    ['+971 50 123 4567 ext 12', 'malformed'],
    ['Mobile: +971 50 123 4567', 'malformed'],
    ['971501234567, 971501234568', 'malformed'],
    ['٠٥٠١٢٣٤٥٦٧', 'malformed'],
    ['abc', 'malformed'],
    // local numbers: leading 0, no country code
    ['0501234567', 'missing_country_code'],
    ['050 123 4567', 'missing_country_code'],
    ['+0501234567', 'missing_country_code'],
    ['04 123 4567', 'missing_country_code'],
    // local UAE mobiles saved without 971 (the unanswered customer)
    ['50 455 5843', 'too_short'],
    ['504555843', 'too_short'],
    ['0050123456', 'too_short'],
    ['12345', 'too_short'],
    ['1234567890123456', 'too_long'],
    // 10-digit national numbers typed without their country code:
    // the first digits spell a country whose numbers look nothing
    // like the rest (+98 Iran, +41 Switzerland, +30 Greece, +91
    // India, +1 North America)
    ['98765 43210', 'invalid_number'], // Indian mobile
    ['9876543210', 'invalid_number'],
    ['415-555-0123', 'invalid_number'], // US
    ['4155550123', 'invalid_number'],
    ['3001234567', 'invalid_number'], // Pakistani mobile
    ['9171234567', 'invalid_number'], // Filipino mobile
    ['1012345678', 'invalid_number'], // Egyptian mobile
    ['123456789012345', 'invalid_number'],
    // no country code starts with 89 or 991
    ['8912345678', 'invalid_number'],
    ['9912345678', 'invalid_number'],
    // malformed UAE numbers of 10+ digits (all live, none delivered)
    ['9712123456', 'invalid_uae'], // 971 + 7 digits
    ['97150123456', 'invalid_uae'], // mobile missing a digit
    ['9715512345678', 'invalid_uae'], // mobile with an extra digit
    ['+971 50 123 45678', 'invalid_uae'],
    ['97100501234567', 'invalid_uae'], // two zeros after 971
    ['9715', 'invalid_uae'],
  ])('%s → %s', (raw, reason) => {
    const result = validateContactPhone(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('tells the person to add the country code, with an example', () => {
    for (const raw of [
      '0501234567',
      '504555843',
      '9.71505E+11',
      '97150123456',
      '1234567890123456',
      '98765 43210',
      '8912345678',
      '919876543210.0',
      '+44 77OO 900123',
    ]) {
      const result = validateContactPhone(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(PHONE_EXAMPLE);
        expect(result.error).toContain(raw);
      }
    }
    expect(PHONE_EXAMPLE).toBe('+971 50 123 4567');
  });

  it('says which country code a misread number was read as', () => {
    expect(validateContactPhone('98765 43210')).toMatchObject({
      error: expect.stringContaining('country code +98'),
    });
    expect(validateContactPhone('8912345678')).toMatchObject({
      error: expect.stringContaining('does not start with a country code'),
    });
  });

  it('names the character that is not part of a number', () => {
    expect(validateContactPhone('+44 77OO 900123')).toMatchObject({
      error: expect.stringContaining('contains "O"'),
    });
    expect(validateContactPhone('919876543210.0')).toMatchObject({
      error: expect.stringContaining('decimal part'),
    });
  });

  it('names the field the caller asks for', () => {
    expect(validateContactPhone('0501234567', "'phone'")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^'phone' "0501234567" has no country code/),
    });
    expect(validateContactPhone('', "'phone'")).toMatchObject({
      error: "'phone' is required",
    });
    expect(validateContactPhone('')).toMatchObject({
      error: 'Phone number is required',
    });
  });

  it('truncates a long echoed input', () => {
    const result = validateContactPhone('1'.repeat(40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`"${'1'.repeat(32)}…"`);
      expect(result.error).not.toContain('1'.repeat(33));
    }
  });

  it('refuses an overlong input before any pattern runs', () => {
    // The spreadsheet patterns backtrack quadratically on a run of
    // digits: 40,000 digits took ~6 s, blocking the process for
    // every account. The length cap answers in constant time.
    for (const raw of [
      '9'.repeat(100_000),
      `${'9'.repeat(100_000)}.0`,
      `${'1'.repeat(100_000)}e`,
    ]) {
      const started = performance.now();
      const result = validateContactPhone(raw, "'phone'");
      expect(performance.now() - started).toBeLessThan(50);
      expect(result).toMatchObject({
        ok: false,
        reason: 'too_long',
        error: expect.stringMatching(/^'phone' "\d{32}…" is longer than 64/),
      });
    }
  });

  it('puts the cap at 64 characters', () => {
    const at = `+971${' '.repeat(51)}501234567`;
    expect(at).toHaveLength(64);
    expect(validateContactPhone(at)).toEqual({
      ok: true,
      normalized: '971501234567',
    });
    expect(validateContactPhone(`+971 ${at.slice(4)}`)).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('validatePhoneToSave', () => {
  it('keeps an unchanged number as typed without validating it', () => {
    // A legacy local-format row stays editable: renaming the contact
    // must not demand a phone fix first.
    expect(validatePhoneToSave('50 455 5843', '504555843')).toEqual({
      ok: true,
      phone: '504555843',
      changed: false,
    });
  });

  it('validates and normalizes a changed number', () => {
    expect(validatePhoneToSave('50 455 5843', '+971 050 455 5843')).toEqual({
      ok: true,
      phone: '971504555843',
      changed: true,
    });
  });

  it('refuses a changed number that is invalid', () => {
    const result = validatePhoneToSave('971504555843', '0504555843');
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_country_code',
    });
  });

  it('treats a missing original as a new entry', () => {
    expect(validatePhoneToSave(null, '504555843')).toMatchObject({
      ok: false,
      reason: 'too_short',
    });
    expect(validatePhoneToSave(null, '+971 50 123 4567')).toEqual({
      ok: true,
      phone: '971501234567',
      changed: true,
    });
  });

  it('requires a number', () => {
    expect(validatePhoneToSave('971504555843', '  ')).toMatchObject({
      ok: false,
      reason: 'required',
    });
  });
});

describe('partitionRowsByPhone', () => {
  it('normalizes good rows and reports bad ones by index', () => {
    const { valid, rejected } = partitionRowsByPhone([
      { phone: '+971 050 123 4567', name: 'A' },
      { phone: '050 123 4567', name: 'B' },
      { phone: '+65 9123 4567', name: 'C' },
      { phone: '9.71505E+11', name: 'D' },
    ]);
    expect(valid).toEqual([
      { phone: '971501234567', name: 'A' },
      { phone: '6591234567', name: 'C' },
    ]);
    expect(rejected.map((r) => [r.index, r.row.name, r.reason])).toEqual([
      [1, 'B', 'missing_country_code'],
      [3, 'D', 'scientific_notation'],
    ]);
  });

  it('does not mutate the input rows', () => {
    const rows = [{ phone: '+971 50 123 4567' }];
    partitionRowsByPhone(rows);
    expect(rows[0].phone).toBe('+971 50 123 4567');
  });
});

describe('CSV import pipeline (parse → validate → de-dupe)', () => {
  it('drops bad rows and collapses trunk-0 twins onto one number', () => {
    // What the contacts importer and the broadcast CSV step run, in
    // that order: a spreadsheet export with a scientific-notation cell,
    // a local number, and the same mobile written two ways.
    const csv = [
      'name,phone',
      'Amal,+971 050 123 4567',
      'Amal again,971501234567',
      'Excel,9.71505E+11',
      'Local,050 765 4321',
      'Beirut,+961 71 123 456',
    ].join('\n');
    const { rows } = parseContactCsv(csv);
    const { valid, rejected } = partitionRowsByPhone(rows);
    const { unique, duplicates } = dedupeByPhone(valid);

    expect(unique.map((r) => [r.name, r.phone])).toEqual([
      ['Amal', '971501234567'],
      ['Beirut', '96171123456'],
    ]);
    expect(duplicates).toBe(1);
    expect(rejected.map((r) => [r.row.name, r.reason])).toEqual([
      ['Excel', 'scientific_notation'],
      ['Local', 'missing_country_code'],
    ]);
    expect(summarizeRejectedPhones(rejected)).toMatch(
      /^Phone number "9\.71505E\+11" is in spreadsheet scientific notation.*\(\+1 more\)$/
    );
  });

  it('collapses a number written with its trunk 0 onto the plain one', () => {
    const csv = [
      'name,phone',
      'Signature,+44 (0)7700 900123',
      'Plain,447700900123',
      'Float,447700900123.0',
      'Local,98765 43210',
    ].join('\n');
    const { rows } = parseContactCsv(csv);
    const { valid, rejected } = partitionRowsByPhone(rows);
    const { unique, duplicates } = dedupeByPhone(valid);

    expect(unique.map((r) => [r.name, r.phone])).toEqual([
      ['Signature', '447700900123'],
    ]);
    expect(duplicates).toBe(1);
    expect(rejected.map((r) => [r.row.name, r.reason])).toEqual([
      ['Float', 'malformed'],
      ['Local', 'invalid_number'],
    ]);
  });
});

describe('summarizeRejectedPhones', () => {
  it('shows the first error and counts the rest', () => {
    expect(summarizeRejectedPhones([])).toBe('');
    expect(summarizeRejectedPhones([{ error: 'bad A' }])).toBe('bad A');
    expect(
      summarizeRejectedPhones([
        { error: 'bad A' },
        { error: 'bad B' },
        { error: 'bad C' },
      ])
    ).toBe('bad A (+2 more)');
  });
});
