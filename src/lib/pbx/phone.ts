import {
  validateContactPhone,
  withUaeCountryCode,
} from '@/lib/contacts/phone-validation';
import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';

/**
 * A caller or callee number from the PBX, in the form contacts are
 * stored: digits only, international, no "+". `internal` marks a short
 * number (an extension, a ring group, a feature code), which is never a
 * customer and must not be matched against contacts.
 */
export type RemoteNumber =
  { internal: false; number: string } | { internal: true; number: string };

/** Extensions and short codes; anything longer is an outside number. */
const MAX_INTERNAL_DIGITS = 6;
/** Arabic-Indic U+0660-0669 and Eastern Arabic-Indic U+06F0-06F9. */
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits as 0-9; everything else unchanged. */
export function latinDigits(text: string): string {
  return text.replace(ARABIC_DIGITS, (c) => String(c.charCodeAt(0) & 0xf));
}

/**
 * A typed number search as the digits to find inside a stored number
 * (international, no "+"): a leading `00`, then one leading `0`, is how
 * a number is dialled, not part of what is stored. '' for only those
 * zeros: the empty search. When fewer than two digits would be left the
 * zeros stay (`001` is not a search for every 1). (Contact search, 193,
 * drops every leading zero in SQL.)
 */
export function numberSearchTerm(typed: string): string {
  const digits = latinDigits(typed).replace(/\D/g, '');
  if (/^0{0,2}$/.test(digits)) return '';
  const bare = digits.replace(/^00/, '').replace(/^0/, '');
  return bare.length >= 2 ? bare : digits;
}

/**
 * Like an inbound WhatsApp number, a trunk's caller ID is authoritative,
 * so nothing is refused: `validateContactPhone` only canonicalises (a
 * trunk 0 after the country code) when it accepts the number, and the
 * plain digits are kept when it does not. Null when there are no digits
 * at all ("anonymous", a withheld number).
 *
 * A national number (trunk 0, e.g. UAE "050 123 4567" or "04 123 4567")
 * takes `defaultCountry`; so does a bare UAE mobile ("50 123 4567"),
 * via the same `withUaeCountryCode` the CSV import uses.
 */
export function normalizeRemoteNumber(
  raw: string | null | undefined,
  { defaultCountry = '971' }: { defaultCountry?: string } = {}
): RemoteNumber | null {
  const text = latinDigits(raw ?? '');
  const digits = normalizePhone(text);
  if (!digits) return null;
  let intl: string;
  if (/^\D*\+/.test(text)) intl = digits;
  else if (digits.startsWith('00')) intl = digits.slice(2);
  else if (digits.length <= MAX_INTERNAL_DIGITS)
    return { internal: true, number: digits };
  else if (digits.startsWith('0')) intl = defaultCountry + digits.slice(1);
  else if (defaultCountry === '971') intl = withUaeCountryCode(digits);
  else intl = digits;
  const checked = validateContactPhone(intl);
  return { internal: false, number: checked.ok ? checked.normalized : intl };
}

/**
 * The values to look a contact up by, exact form first: the number plus
 * the trunk-0 variants `phoneVariants` already retries sends with. A
 * miss on all of them falls back to `phonesMatch`, as
 * `findExistingContact` does.
 */
export function contactPhoneCandidates(normalized: string): string[] {
  return phoneVariants(normalizePhone(normalized));
}

/**
 * Every `contacts.phone_normalized` that is this number. The column is
 * the digits of the phone as it was typed (022: no country code added),
 * so an older contact may hold the national or the `00` form: the
 * inverse of `normalizeRemoteNumber`. For finding a contact, or a
 * do-not-contact stamp, by number; `contactPhoneCandidates` stays the
 * list `pbx_phone_variants` mirrors.
 */
export function storedPhoneCandidates(normalized: string): string[] {
  const digits = normalizePhone(normalized);
  const out = new Set(contactPhoneCandidates(digits));
  if (!digits) return [];
  out.add(`00${digits}`);
  const national = /^971(\d{7,})$/.exec(digits)?.[1];
  if (national) {
    out.add(`0${national}`);
    if (/^5\d{8}$/.test(national)) out.add(national);
  }
  return [...out];
}
