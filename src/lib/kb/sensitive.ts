import {
  CARD,
  EID,
  PHONE_INTL,
  PHONE_UAE,
  luhnValid,
  normaliseDigits,
} from '@/lib/typesafe/redact';

/**
 * IBAN length per country, for the countries this business's customers
 * bank in (GCC, nearby, UK and the common EU set). India has no IBAN.
 */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AE: 23,
  SA: 24,
  QA: 29,
  KW: 30,
  BH: 22,
  JO: 30,
  LB: 28,
  EG: 29,
  PK: 24,
  TR: 26,
  GB: 22,
  IE: 22,
  DE: 22,
  FR: 27,
  NL: 18,
  BE: 16,
  LU: 20,
  AT: 20,
  CH: 21,
  IT: 27,
  ES: 24,
  PT: 25,
};

/**
 * An IBAN-shaped run: country + check digits, then either no
 * separators or a space/dash between groups of four (the printed form,
 * last group shorter). Not redact.ts's IBAN_OTHER, which joins
 * characters across words ("ref AB12 3456 7890 please" → one token).
 */
const IBAN_CANDIDATE =
  /\b[A-Z]{2}\d{2}(?:(?:[ -][A-Z0-9]{4})+(?:[ -][A-Z0-9]{1,3})?|[A-Z0-9]{10,30})\b/gi;

/** ISO 13616 mod-97 check of a compact, upper-case IBAN. */
function ibanChecksumValid(iban: string): boolean {
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem === 1;
}

/** A real IBAN: a known country, its length, and a valid checksum. */
export function isValidIban(compact: string): boolean {
  const iban = compact.toUpperCase();
  return (
    IBAN_LENGTHS[iban.slice(0, 2)] === iban.length &&
    /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) &&
    ibanChecksumValid(iban)
  );
}

function containsIban(text: string): boolean {
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    // A grouped match can run on into the next word ("… 456 and"), so
    // each group boundary is tried as the end, longest first.
    const groups = m[0].split(/[ -]/);
    for (let k = groups.length; k >= 1; k--) {
      if (isValidIban(groups.slice(0, k).join(''))) return true;
    }
  }
  return false;
}

/**
 * True when a customer message carries an Emirates ID, a card number
 * (Luhn-checked) or an IBAN: the approved-answers bot then sends the
 * account's `sensitive_data_reply` instead of an answer.
 *
 * Emirates ID, card and phone patterns are redact.ts's, so the two
 * never disagree about those. IBANs are stricter than redact's: a
 * false positive here costs the customer their answer, so only a
 * checksum-valid IBAN of a known country counts. The shared patterns
 * are global regexes, so they are only used through match / matchAll /
 * replace (which reset lastIndex), never .test().
 */
export function containsSensitiveData(text: string): boolean {
  const t = normaliseDigits(text);
  const digits = (s: string) => s.replace(/\D/g, '');

  if (t.match(EID) || containsIban(t)) return true;

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
