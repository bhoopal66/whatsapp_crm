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
  OM: 23,
  IQ: 23,
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
 * Where an IBAN may start: a known-looking country code at a word
 * start, then its check digits, optionally after a space or dash
 * ("AE 07 …"). The rest of the span is read by `ibanAt`.
 */
const IBAN_START = /(?<![A-Z0-9])([A-Z]{2})[ -]?(\d{2})/gi;

const ALNUM = /[A-Z0-9]/i;

/** The fewest digits a real BBAN (the IBAN after its first four
 *  characters) has among the countries above. Prose that happens to
 *  start with a country code ("at 20 Main Street …") has far fewer,
 *  so it never reaches the checksum. */
const MIN_BBAN_DIGITS = 10;
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

/**
 * The compact IBAN a span starting at `m` spells, or null. Separators
 * (a space or dash) may fall anywhere, so irregular grouping
 * ("AE07033123456789 0123456") still reads; but the span takes exactly
 * the country's length in characters and must end at a word end, so
 * it never borrows part of a following word ("… 456 and") nor stops
 * inside a longer one.
 */
function ibanAt(text: string, m: RegExpMatchArray): string | null {
  const country = m[1].toUpperCase();
  const length = IBAN_LENGTHS[country];
  if (!length) return null;
  let compact = country + m[2];
  let i = (m.index ?? 0) + m[0].length;
  while (compact.length < length && i < text.length) {
    const ch = text[i];
    if (ALNUM.test(ch)) compact += ch.toUpperCase();
    else if (ch !== ' ' && ch !== '-') break;
    i++;
  }
  if (compact.length !== length) return null;
  if (i < text.length && ALNUM.test(text[i])) return null;
  if (compact.slice(4).replace(/\D/g, '').length < MIN_BBAN_DIGITS) {
    return null;
  }
  return compact;
}

function containsIban(text: string): boolean {
  // One space for any whitespace run (a pasted NBSP, a double space).
  const t = text.replace(/\s+/g, ' ');
  for (const m of t.matchAll(IBAN_START)) {
    const iban = ibanAt(t, m);
    if (iban && isValidIban(iban)) return true;
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
