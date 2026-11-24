import { describe, expect, it } from 'vitest';
import {
  normalizePhone,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import { contactSearchFilter as groupFilter } from '@/lib/groups/ui';
import { matchesInboxSearch } from '@/lib/inbox/search';
import { latinDigits } from './digits';
import { searchRpcTerm } from './fuzzy-search';
import { contactSearchFilter } from './list-query';
import { phoneDigits, phoneSearchDigits } from './phone-search';
import {
  validateContactPhone,
  validatePhoneToSave,
  withUaeCountryCode,
} from './phone-validation';
import { sanitizeContactSearch } from './search';

const AR = '٠٥٨٨٣٣٦٥٠٣';
const FA = '۰۵۸۸۳۳۶۵۰۳';

describe('Arabic-keyboard digits', () => {
  it('read as 0-9, other text unchanged', () => {
    expect(latinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ علي x')).toBe(
      '0123456789 0123456789 علي x'
    );
  });

  it.each([AR, FA])('search: %s is a phone search', (typed) => {
    expect(sanitizeContactSearch(typed)).toBe('0588336503');
    expect(searchRpcTerm(typed)).toBe('0588336503');
    expect(phoneSearchDigits(typed)).toBe('588336503');
    expect(phoneDigits(typed)).toBe('0588336503');
    expect(contactSearchFilter(typed)).toContain(
      'phone_normalized.like.%588336503%'
    );
    expect(
      matchesInboxSearch({ contact: { phone: '+971 58 833 6503' } }, typed)
    ).toBe(true);
    expect(groupFilter(typed)).toContain('phone.ilike.*0588336503*');
  });

  it('a typed or imported number keeps its digits', () => {
    expect(normalizePhone('+٩٧١ ٥٨ ٨٣٣ ٦٥٠٣')).toBe('971588336503');
    expect(sanitizePhoneForMeta('+۹۷۱ ۵۸ ۸۳۳ ۶۵۰۳')).toBe('971588336503');
    expect(validatePhoneToSave('0588336503', AR)).toMatchObject({
      ok: true,
      phone: '0588336503',
      changed: false,
    });
    expect(withUaeCountryCode(AR)).toBe('971588336503');
    expect(validateContactPhone('+٩٧١ ٥٨ ٨٣٣ ٦٥٠٣')).toMatchObject({
      ok: true,
      normalized: '971588336503',
    });
  });
});
