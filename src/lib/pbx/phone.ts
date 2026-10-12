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
  const text = (raw ?? '').replace(ARABIC_DIGITS, (c) =>
    String(c.charCodeAt(0) & 0xf)
  );
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
 * miss on all of them falls back to the last-8-digit `phonesMatch`, as
 * `findExistingContact` does.
 */
export function contactPhoneCandidates(normalized: string): string[] {
  return phoneVariants(normalizePhone(normalized));
}
