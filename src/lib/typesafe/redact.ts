/**
 * PII redaction applied to every string before it leaves the process.
 * Order matters: longer, more specific identifiers are replaced first.
 *
 * Not redacted (disclosed in spec §9.2): personal and company names.
 */

const ND = /\p{Nd}/u;

/**
 * Folds every decimal digit to ASCII so the patterns below (ASCII `\d`)
 * see it: NFKC first (fullwidth and mathematical digits), then any other
 * Unicode decimal digit (Arabic-Indic, Extended Arabic-Indic, Devanagari,
 * Bengali, …). Unicode lays each script's digits out as a contiguous run
 * of ten starting at zero, so a digit's value is its distance from the
 * start of its run, modulo 10.
 */
export function normaliseDigits(text: string): string {
  const src = [...text.normalize('NFKC')];
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '٬') {
      out += ','; // Arabic thousands separator
      continue;
    }
    if (ch === '٫') {
      out += '.'; // Arabic decimal separator
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp > 127 && ND.test(ch)) {
      let zero = cp;
      while (ND.test(String.fromCodePoint(zero - 1))) zero--;
      out += String((cp - zero) % 10);
      continue;
    }
    out += ch;
  }
  return out;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Separators people type inside numbers: space, dot, dash, slash, parentheses.
// Emirates ID: 784-YYYY-NNNNNNN-N
const EID = /(?<!\d)784[\s.\-/]*\d{4}[\s.\-/]*\d{7}[\s.\-/]*\d(?!\d)/g;
// UAE IBAN: AE + 2 check digits + 19 digits; spaces or dashes allowed
const IBAN_AE = /\bAE[\s\-]?\d{2}(?:[\s\-]?\d){19}(?!\d)/gi;
// Any other IBAN-shaped token (foreign accounts), any case; must contain ≥ 8 digits
const IBAN_OTHER = /\b[A-Z]{2}\d{2}(?:[\s\-]?[A-Z0-9]){11,30}\b/gi;
// Card candidates: 13–19 digits with up to 3 separators between digits; Luhn-checked
const CARD = /(?<!\d)(?:\d[\s.\-/]{0,3}){12,18}\d(?!\d)/g;
// Bank account numbers after an explicit label
const ACCOUNT =
  /\b(?:account|acct|a\/c)\s*(?:no\.?|number|num|#)?\s*(?:is)?\s*[:\-]?\s*\d[\d\s\-]{5,}\d/gi;
const ACCOUNT_AR =
  /(?:رقم الحساب|حساب رقم|رقم حسابي)\s*[:\-]?\s*\d[\d\s\-]{5,}\d/g;
// UAE phone numbers (+971 / 00971 / 971 / local 0-prefixed, optional parentheses)
const PHONE_UAE =
  // No '/' here: this runs before the date exemption, and "27/09/2026 10"
  // would read as a landline. Slashed numbers are caught by LONG_DIGITS.
  /(?<!\d)(?:(?:\+|00)?971[\s.\-]*(?:\(0\)[\s.\-]*)?|\(?0)(?:5\d|[2-9])\)?(?:[\s.\-]*\d){7}(?!\d)/g;
// Other international numbers: +CC then groups (checked for 8–15 digits)
const PHONE_INTL =
  /\+\s?\d{1,3}[\s.\-]*(?:\(?\d{1,4}\)?[\s.\-]*){1,5}\d{2,4}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Passport / document numbers: 1–2 letters + 6–8 digits
const DOC_NO = /\b[A-Za-z]{1,2}\d{6,8}\b/g;
// Passport number written with a space after an explicit label ("passport no Z 1234567")
const PASSPORT_LABELLED =
  /\b(passport|جواز)\s*(?:no\.?|number|#|رقم)?\s*[:\-]?\s*[A-Za-z]{1,2}\s\d{6,8}\b/gi;
// Trade licence numbers after a label; the value must contain a digit
const LICENCE =
  /(\btrade\s+licen[cs]e|\blicen[cs]e|\bTL|رخصة تجارية|رخصة)\s*(?:no\.?|number|#|is|رقم)?\s*[:\-]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}/gi;
// Safety net: any remaining run of ≥ 9 digits (space . - / ( ) separators, up to 3
// between digits; commas break a run, so comma-grouped amounts are never matched).
// Dates and currency amounts are exempt.
const LONG_DIGITS = /(?<!\d)\(?\d(?:[\s.\-/()]{0,3}\d){8,}(?!\d)/g;
const RUN_9 = /\d(?:[\s.\-/()]{0,3}\d){8,}/g;

// One amount: comma- or space-grouped thousands (up to trillions), or an
// ungrouped number of at most 10 digits, with optional decimals. Bounded
// both ways, so an identifier typed next to or as an amount ("AED 500
// 123456789012", "AED 1234567890123") is not swallowed into its exemption.
const AMOUNT = String.raw`(?:\d{1,3}(?:[,\s]\d{3}){1,4}|\d{1,10})(?:\.\d+)?`;
const CURRENCY = String.raw`(?:aed|dhs?\.?|dirhams?|درهم)`;
// A currency word must stand alone: "Saed" or "Raed" is a name, not "aed".
const CURRENCY_BEFORE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${CURRENCY}\s*${AMOUNT}(?!\d)`,
  'giu'
);
const CURRENCY_AFTER = new RegExp(
  String.raw`(?<![\d.,])${AMOUNT}\s*${CURRENCY}(?![\p{L}\p{N}])`,
  'giu'
);

/** Spans that look like dates or currency amounts — shared by redact() and the leak check. */
function benignSpans(t: string): [number, number][] {
  const spans: [number, number][] = [];
  const add = (re: RegExp) => {
    for (const m of t.matchAll(re))
      spans.push([m.index!, m.index! + m[0].length]);
  };
  add(
    /\b(?:19|20)\d{2}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]\d|3[01])\b/g
  ); // 2026-09-27, 2026/09/27
  add(
    /\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:(?:19|20)\d{2}|\d{2})\b/g
  ); // 27.09.2026, 27/9/26
  add(CURRENCY_BEFORE); // AED 150 000 000
  add(CURRENCY_AFTER); // 150000000 AED
  return spans;
}
/** Digits of text[s,e) that fall outside every benign span. */
function digitsOutside(
  t: string,
  spans: [number, number][],
  s: number,
  e: number
): number {
  let n = 0;
  for (let i = s; i < e; i++) {
    const c = t.charCodeAt(i);
    if (c >= 48 && c <= 57 && !spans.some(([a, b]) => i >= a && i < b)) n++;
  }
  return n;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  let t = normaliseDigits(input);

  t = t.replace(EMAIL, () => {
    bump('EMAIL');
    return '[EMAIL]';
  });
  t = t.replace(EID, () => {
    bump('EID');
    return '[EID]';
  });
  t = t.replace(IBAN_AE, () => {
    bump('IBAN');
    return '[IBAN]';
  });
  t = t.replace(IBAN_OTHER, (m) =>
    digitsOf(m).length >= 8 ? (bump('IBAN'), '[IBAN]') : m
  );
  t = t.replace(CARD, (m) => {
    const d = digitsOf(m);
    if (d.length >= 13 && d.length <= 19 && luhnValid(d)) {
      bump('CARD');
      return '[CARD]';
    }
    return m;
  });
  t = t.replace(ACCOUNT, () => {
    bump('ACCOUNT');
    return 'account [ACCOUNT]';
  });
  t = t.replace(ACCOUNT_AR, () => {
    bump('ACCOUNT');
    return 'رقم الحساب [ACCOUNT]';
  });
  t = t.replace(PHONE_UAE, () => {
    bump('PHONE');
    return '[PHONE]';
  });
  t = t.replace(PHONE_INTL, (m) => {
    const n = digitsOf(m).length;
    return n >= 8 && n <= 15 ? (bump('PHONE'), '[PHONE]') : m;
  });
  t = t.replace(LICENCE, (_m, label: string) => {
    bump('LICENCE');
    return `${label} [LICENCE]`;
  });
  t = t.replace(PASSPORT_LABELLED, (_m, label: string) => {
    bump('DOC');
    return `${label} [DOC]`;
  });
  t = t.replace(DOC_NO, () => {
    bump('DOC');
    return '[DOC]';
  });
  const benign = benignSpans(t);
  t = t.replace(LONG_DIGITS, (m, offset: number) => {
    if (digitsOutside(t, benign, offset, offset + m.length) < 9) return m; // mostly a date / amount
    bump('NUMBER');
    return '[NUMBER]';
  });
  return { text: t, counts };
}

/** Deep-redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value).text as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Runtime assertion used before every call: true if an e-mail or any run of
 * ≥ 9 digits (ignoring separators) survived redaction. Deliberately simpler
 * and broader than the redaction patterns, so it is an independent check.
 */
export function containsRawIdentifier(text: string): boolean {
  const t = normaliseDigits(text);
  EMAIL.lastIndex = 0;
  if (EMAIL.test(t)) return true;
  // Commas break a run (comma-grouped amounts); dates and currency amounts are exempt.
  const benign = benignSpans(t);
  for (const m of t.matchAll(RUN_9)) {
    if (digitsOutside(t, benign, m.index!, m.index! + m[0].length) >= 9)
      return true;
  }
  return false;
}

const LETTER = /\p{L}/u;
const ARABIC = /\p{Script=Arabic}/u;
const LATIN = /\p{Script=Latin}/u;
/** Tatweel stretches Arabic words ("مـــرحـــبـــا"); it is script Common. */
const TATWEEL = '\u0640';
/**
 * Letters Urdu and Persian use and Arabic does not (پ چ ژ گ are also Gulf
 * dialect spellings, so they alone are not enough). Arabic-script text
 * where these make up a tenth of the letters is not Arabic, and must not
 * act once Arabic has been calibrated.
 */
const URDU_PERSIAN =
  /[\u06A9\u06AF\u06BA\u06BE\u06C1\u06C3\u06CC\u06D2\u06D3\u0679\u0688\u0691\u067E\u0686\u0698]/u;

/**
 * Rough language tag: decides language shadowing and labels the log.
 * `other` is any other script (Devanagari, Malayalam, Cyrillic, CJK…)
 * making up a fifth or more of the letters — languages no calibration
 * has covered. `unknown` is text with no letters at all.
 */
export function detectLanguage(
  text: string
): 'en' | 'ar' | 'mixed' | 'other' | 'unknown' {
  let ar = 0;
  let la = 0;
  let other = 0;
  let urdu = 0;
  for (const ch of text) {
    if (ch === TATWEEL || !LETTER.test(ch)) continue;
    if (ARABIC.test(ch)) {
      ar++;
      if (URDU_PERSIAN.test(ch)) urdu++;
    } else if (LATIN.test(ch)) la++;
    else other++;
  }
  const letters = ar + la + other;
  if (letters === 0) return 'unknown';
  if (other / letters >= 0.2 || urdu / letters >= 0.1) return 'other';
  if (ar > 0 && la > 0) {
    const share = ar / (ar + la);
    if (share > 0.8) return 'ar';
    if (share < 0.2) return 'en';
    return 'mixed';
  }
  return ar > 0 ? 'ar' : 'en';
}
