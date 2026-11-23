import {
  callingCodeOf,
  validateContactPhone,
} from '@/lib/contacts/phone-validation';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

// Lives here rather than in `whatsapp/phone-utils`, which
// `phone-validation` imports: the numbering plan decides whether a
// number carries a country code.

/** A national number typed without its country code has at most 10 digits. */
const MAX_LOCAL_DIGITS = 10;

/** Digits only, the "00" international prefix dropped. */
function internationalDigits(phone: string): string {
  const digits = normalizePhone(phone);
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

/**
 * True for a number stored without its country code ("050 123 0043",
 * "50 123 0043", "98765 43210").
 */
export function isLocalPhone(phone: string): boolean {
  const digits = internationalDigits(phone);
  if (!digits) return false;
  if (digits.startsWith('0')) return true;
  return digits.length <= MAX_LOCAL_DIGITS && !validateContactPhone(digits).ok;
}

/** An international number without the trunk 0 after its country code. */
function withoutTrunkZero(phone: string): string {
  const digits = internationalDigits(phone);
  const checked = validateContactPhone(digits);
  if (checked.ok) return checked.normalized;
  // The gateway's numbers may break the entry rules.
  const code = callingCodeOf(digits);
  return code && digits[code.length] === '0'
    ? code + digits.slice(code.length + 1)
    : digits;
}

/**
 * Whether two phone numbers are the same line. Two international numbers
 * match only when equal, or equal but for the trunk 0 after the country
 * code ("370063949836" and "37063949836"): +971 50 123 4567 and
 * +966 50 123 4567 share their last 8 digits and are two people. Only a
 * number with no country code is compared by those 8 digits, which is a
 * guess: callers accept it only when exactly one contact matches.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1);
  const n2 = normalizePhone(phone2);
  if (n1 === n2) return true;
  if (n1.length < 8 || n2.length < 8) return false;
  return isLocalPhone(n1) || isLocalPhone(n2)
    ? n1.slice(-8) === n2.slice(-8)
    : withoutTrunkZero(n1) === withoutTrunkZero(n2);
}
