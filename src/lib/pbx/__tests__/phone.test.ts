import { describe, expect, it } from 'vitest';
import { contactPhoneCandidates, normalizeRemoteNumber } from '../phone';

const intl = (number: string) => ({ internal: false, number });

describe('normalizeRemoteNumber', () => {
  it.each([
    ['+971 50 123 4567', '971501234567'],
    ['00971501234567', '971501234567'],
    ['971501234567', '971501234567'],
    ['+971 050 123 4567', '971501234567'],
    ['050-123-4567', '971501234567'],
    ['0501234567', '971501234567'],
    ['501234567', '971501234567'],
    ['04 123 4567', '97141234567'],
    ['(04) 123-4567', '97141234567'],
    ['+44 7700 900123', '447700900123'],
    ['‏+971 50 123 4567', '971501234567'],
  ])('%s → %s', (raw, number) => {
    expect(normalizeRemoteNumber(raw)).toEqual(intl(number));
  });

  it('converts Arabic-Indic and Eastern Arabic-Indic digits', () => {
    expect(normalizeRemoteNumber('٠٥٠١٢٣٤٥٦٧')).toEqual(intl('971501234567'));
    expect(normalizeRemoteNumber('+٩٧١ ٥٠ ١٢٣ ٤٥٦٧')).toEqual(
      intl('971501234567')
    );
    expect(normalizeRemoteNumber('۰۵۰۱۲۳۴۵۶۷')).toEqual(intl('971501234567'));
  });

  it('short numbers are internal extensions', () => {
    expect(normalizeRemoteNumber('2002')).toEqual({
      internal: true,
      number: '2002',
    });
    expect(normalizeRemoteNumber('6400')).toEqual({
      internal: true,
      number: '6400',
    });
    expect(normalizeRemoteNumber('٢٠٠٢')).toEqual({
      internal: true,
      number: '2002',
    });
    expect(normalizeRemoteNumber('123456')).toEqual({
      internal: true,
      number: '123456',
    });
  });

  it('no digits is null', () => {
    for (const raw of ['', 'anonymous', null, undefined])
      expect(normalizeRemoteNumber(raw)).toBeNull();
  });

  it('another default country for national numbers', () => {
    expect(
      normalizeRemoteNumber('07700 900123', { defaultCountry: '44' })
    ).toEqual(intl('447700900123'));
    expect(
      normalizeRemoteNumber('501234567', { defaultCountry: '44' })
    ).toEqual(intl('501234567'));
  });

  it('keeps a number the contact rules would refuse: the trunk is authoritative', () => {
    expect(normalizeRemoteNumber('+1 202 555')).toEqual(intl('1202555'));
  });
});

describe('contactPhoneCandidates', () => {
  it('exact value first, then the trunk-0 variants phoneVariants uses', () => {
    const c = contactPhoneCandidates('971501234567');
    expect(c[0]).toBe('971501234567');
    expect(c).toContain('9710501234567');
    expect(new Set(c).size).toBe(c.length);
    expect(contactPhoneCandidates('')).toEqual([]);
  });
});
