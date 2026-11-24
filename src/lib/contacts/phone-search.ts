import { latinDigits } from './digits';

/**
 * Phone search on digits. A phone is stored as typed (`+971 58 833 6503`),
 * so a search for `588336503` never matches the raw text; the database
 * keeps `contacts.phone_normalized`, the phone's digits alone (generated,
 * migration 022), and a search on digits matches that by substring.
 */

/** Fewer digits than this is not a phone search. */
export const PHONE_SEARCH_MIN_DIGITS = 4;

/**
 * The digits to look for in `phone_normalized`, or null when the term is
 * a name search (it holds a letter) or too short to be a phone. A leading
 * `+`, `00` or trunk `0` is dropped, so `0588336503`, `+971588336503`,
 * `00971588336503`, `588336503` and `58 833 6503` all match
 * `971588336503` by substring.
 */
export function phoneSearchDigits(term: string): string | null {
  if (/\p{L}/u.test(term)) return null;
  const digits = latinDigits(term).replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : null;
}

/** A phone's digits, for comparing against {@link phoneSearchDigits}. */
export function phoneDigits(phone: string | null | undefined): string {
  return latinDigits(phone ?? '').replace(/\D/g, '');
}
