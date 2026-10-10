import {
  CARD,
  EID,
  IBAN_AE,
  IBAN_OTHER,
  PHONE_INTL,
  PHONE_UAE,
  luhnValid,
  normaliseDigits,
} from '@/lib/typesafe/redact';

/**
 * True when a customer message carries an Emirates ID, a card number
 * (Luhn-checked) or an IBAN: the approved-answers bot then sends the
 * account's `sensitive_data_reply` instead of an answer.
 *
 * Uses redact.ts's patterns so the two never disagree about what an
 * identifier looks like. They are global regexes shared with redact(),
 * so they are only used through matchAll / replace (which reset
 * lastIndex), never .test().
 */
export function containsSensitiveData(text: string): boolean {
  const t = normaliseDigits(text);
  const digits = (s: string) => s.replace(/\D/g, '');

  if (t.match(EID) || t.match(IBAN_AE)) return true;
  for (const m of t.matchAll(IBAN_OTHER)) {
    if (digits(m[0]).length >= 8) return true;
  }

  // Phone numbers go first: a 00971 number has 14 digits, and one in
  // ten of those passes Luhn. The replacement is not a CARD separator,
  // so digits on either side cannot join into one run.
  const withoutPhones = t.replace(PHONE_UAE, ' # ').replace(PHONE_INTL, (m) => {
    const n = digits(m).length;
    return n >= 8 && n <= 15 ? ' # ' : m;
  });
  for (const m of withoutPhones.matchAll(CARD)) {
    const d = digits(m[0]);
    if (d.length >= 13 && d.length <= 19 && luhnValid(d)) return true;
  }
  return false;
}
