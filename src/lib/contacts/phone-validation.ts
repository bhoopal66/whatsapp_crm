import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/**
 * The one rule for a contact number that a person or an integration
 * typed: the contact form and detail view, the vCard "save contact"
 * button, CSV import (contacts and broadcast audiences),
 * POST /api/v1/contacts, the contact POST /api/v1/messages creates
 * for a new `to`, and the Compass customer sync.
 *
 * Why it exists: local-format numbers ("50 455 5843", "050…") and
 * spreadsheet-mangled ones ("9.71505E+11") used to be stored as typed.
 * Whapi accepts a send to such a number as 'sent' — to a JID that is
 * nobody — so a customer went unanswered for days with nothing red
 * anywhere. And the inbound match on the last 8 digits then attached
 * the customer's real number to that dead row.
 *
 * Never run this on a number WhatsApp handed us (inbound webhooks):
 * the gateway's number is authoritative even when it breaks these
 * entry rules, and refusing it would drop a real customer's message.
 *
 * Outside the UAE a number must fit the numbering plan of the country
 * code its first digits spell (`NUMBERING_PLAN`). That is what catches
 * a national number typed without its country code: Indian
 * "98765 43210" reads as +98 (Iran) 76543210, which no Iranian number
 * looks like. It cannot catch every one — a misread that happens to
 * fit another country's plan still passes, and nothing short of
 * asking for the country separately can tell "65 9123 4567"
 * (Singapore) from an Indian mobile that starts 659.
 *
 * The floor of 10 digits is deliberate too: it rejects the few real
 * 8–9 digit international numbers (some small island states, some
 * European landlines) — they are vanishingly rare on WhatsApp, and a
 * 9-digit local UAE mobile is the mistake this is here to catch. The
 * UAE gets its exact shape because it is the home market and its
 * malformed entries were live.
 */

export type PhoneValidationReason =
  | 'required'
  | 'scientific_notation'
  | 'malformed'
  | 'missing_country_code'
  | 'too_short'
  | 'too_long'
  | 'invalid_uae'
  | 'invalid_number';

export interface PhoneRejection {
  ok: false;
  /** Stable for code and i18n; `error` is the English sentence. */
  reason: PhoneValidationReason;
  error: string;
}

export type PhoneValidation = { ok: true; normalized: string } | PhoneRejection;

/** The example every error shows, in the format people read aloud. */
export const PHONE_EXAMPLE = '+971 50 123 4567';

const MIN_DIGITS = 10;
/** E.164's ceiling, country code included. */
const MAX_DIGITS = 15;
/**
 * Longest input looked at, in characters. Refused before any pattern
 * runs: SCIENTIFIC_NOTATION and DECIMAL_SUFFIX backtrack quadratically
 * on a long run of digits, and POST /api/v1/contacts hands an
 * unbounded string straight in (40,000 digits took ~6 s and blocked
 * the process for every account). A real number with every separator
 * and a "tel:" prefix is under 30.
 */
const MAX_INPUT_LENGTH = 64;

const UAE = '971';
/** 971 + 5X XXX XXXX. */
const UAE_MOBILE = /^5\d{8}$/;
/**
 * 971 + area code + 7 digits. Never a leading 5: "971 50 123 456" is a
 * mobile missing a digit, not a landline.
 */
const UAE_LANDLINE = /^[1-46-9]\d{7}$/;
/**
 * 971 + 600 + 6 digits (shared-cost) and 971 + 800 + 2 to 9 digits
 * (toll-free), the lengths libphonenumber allows. Banks run WhatsApp
 * on them (Emirates Islamic is +971 600 599995). Neither starts with
 * 5, so neither can be the short local mobile the rule is here for.
 */
const UAE_SERVICE = /^(?:600\d{6}|800\d{2,9})$/;

/** "9.71505E+11" — Excel's rendering of a long number column. */
const SCIENTIFIC_NOTATION = /\d[.,]?\d*e\+?\d/i;
/**
 * "919876543210.0" — a phone column written out as floats (pandas
 * does it whenever the column has a blank). Stripping the dot would
 * keep the 0 as an extra digit, a different number. Seven digits
 * before the dot keeps "971.50.123.4567" out of it.
 */
const DECIMAL_SUFFIX = /\d{7,}\.0+$/;
/**
 * Invisible marks that come along when a number is copied out of
 * right-to-left text or a web page: soft hyphen, Arabic letter mark,
 * zero-width space and joiners, LRM/RLM, bidi embeddings and isolates,
 * word joiner, BOM. Dropped before anything else, so they are neither
 * refused nor echoed back.
 */
const INVISIBLE_MARKS =
  /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** "tel:+971…" — a vCard TEL value or a pasted link. */
const TEL_PREFIX = /^tel:/i;
/**
 * Anything but digits and the separators people put between them —
 * whitespace, + ( ) - . / and the dashes a word processor swaps in for
 * "-". A letter O typed for a zero used to be dropped silently, leaving
 * a shorter, different number.
 */
const NOT_A_PHONE_CHARACTER = /[^\d\s+()\-./\u2010-\u2015\u2212]/;

/**
 * For every country calling code, the national numbers its plan
 * allows, as `first digits:lengths`. "91 1:8-13 2-9:10" reads: after
 * +91, a national number starting with 1 has 8 to 13 digits and one
 * starting with 2 to 9 has exactly 10. Country codes are prefix-free,
 * so at most one entry matches a number.
 *
 * Generated from libphonenumber's PhoneNumberMetadata.xml (master,
 * 2026-09-29): per calling code, the union over every number type of
 * each pattern alternative's possible first digits and lengths. That
 * makes it looser than libphonenumber, never stricter — checked
 * against about 337,000 numbers its patterns accept, none refused. Not
 * taken from it: service numbers that start with 0 (freephone access
 * codes such as India's 000800…), so that a 0 after the country code
 * is read as a trunk 0 everywhere except where subscriber numbers
 * really begin with 0 (Italy, San Marino, Côte d'Ivoire, Burkina Faso,
 * Benin, Gabon, Congo, Rwanda, Tajikistan). Added by hand: "52 1:11",
 * the +52 1 … form WhatsApp still uses for Mexican mobiles. Left out:
 * 971, which the stricter UAE rule above handles. Regenerate from
 * newer metadata rather than hand-editing when a real number is
 * refused.
 */
const NUMBERING_PLAN = `
1 24-9:10 3:7,10; 7 3479:10 8:10,14; 20 189:8-10 2-6:8,9;
27 1-79:9 8:5-10; 30 25-79:10 8:10-12;
31 1:5,6,9 2-57:9 6:9,11 8:5-10 9:7-11; 32 1-35-9:8 4:8,9; 33 1-9:9;
34 4-9:9; 36 19:8 2-8:8,9; 39 0:6-12 1:9,10 3:9-12 45:10 8:6,8-10;
40 23:6,9 6-9:9; 41 2-79:9 8:9,12;
43 1:4-13 2:7-13 3467:6-13 5:5-13 8:8-13 9:9-13;
44 1:9,10 23579:10 8:7,9,10; 45 2-9:8;
46 1348:7-9 2:6-9,12 5:8,9 6:7-9,12 7:9 9:7-10; 47 2-79:8 8:5,8;
48 1-579:7,9 6:6-9 8:7,9,10; 49 1:4-14 2579:6-15 3468:5-15; 51 14-8:8 9:9;
52 1:11 2-9:10; 53 27:7,8 34:6-8,10 56:8 8:8,10; 54 1-3:10 689:10,11;
55 1267:10,11 34:8,10,11 589:9-11; 56 18:9,11 2-579:9 6:9-11;
57 19:10,11 3:10 46:8,10; 58 24-689:10; 60 1:9,10 3-9:8,9;
61 1:5-10,12 2-478:9; 62 1-79:7-11 8:7-12;
63 1:11-13 28:6,8-10 3-7:8-10 9:10; 64 15:7-10 29:8-10 346:8 7:8,9 8:5-10;
65 1:10,11 369:8 7:11 8:8,10,11; 66 1:8-10,13 2-57:8 689:9;
81 125-9:9,10 34:9;
82 12:8-10 3:5,6,8-12 46:5,6,8-10 5:5,6,8-11 7:10 8:9,11,12;
84 1:7-10 2:10 3589:9 6:7-9 7:7,9;
86 1:7,8,10-12 28:7-12 3-579:7-11 6:7-10; 90 2359:10 4:7,10 8:10,12,13;
91 1:8-13 2-9:10; 92 1:9 24-7:9-12 3:10 89:8-12; 93 2-7:9; 94 1-9:9;
95 18:6-10 246:6-9 57:7-9 9:7-10; 98 1-8:6,7,10 9:4,5,10; 211 19:9;
212 5-8:9; 213 1-4:8 5-9:9; 216 2-57-9:8; 218 2-9:9; 220 2-9:7,9;
221 37-9:9; 222 2-48:8; 223 24-9:8; 224 3:8 67:9; 225 02:10; 226 024-7:8;
227 27-9:8; 228 279:8; 229 0:10 8:8; 230 24-6:7,8 3:7 7:8 8:7,8,10;
231 2:7-9 3-578:7,9 6:7; 232 236-9:8; 233 235:9 8:8,9; 234 29:10 78:10-14;
235 236-9:8; 236 26-8:8; 237 26:9 8:8,9; 238 2-589:7; 239 29:7;
240 23589:9; 241 01:8 2-5:7 67:7,8; 242 028:9;
243 125:7-10 346:7 8:7,9 9:9; 244 29:9; 245 4:7,9 9:9; 246 3:7;
247 1589:6 2-467:5; 248 24689:7; 249 19:9; 250 02:8,9 7-9:9; 251 1-57-9:9;
252 1348:6-9 2679:7-9 5:7; 253 27:8; 254 179:9 2:8,9 4-6:7-9 8:9,10;
255 246-9:9; 256 2-47-9:9; 257 2367:8; 258 2:8 8:9; 260 25-9:9; 261 23:9;
262 26-9:9; 263 1-356:7,9 7:9 8:7,9,10; 264 68:8,9; 265 1:7,9 237-9:9;
266 2568:8; 267 24-69:7 3:7,8 7:8 8:10; 268 237:8 9:9; 269 3478:7;
290 256:5 8:4; 291 178:7; 297 25-9:7; 298 2-9:6; 299 1-9:6; 350 256:8;
351 1-36-9:9; 352 2-57-9:4-11 6:9; 353 1:8-10 24-69:7-10 78:9,10;
354 36-8:7,9 459:7; 355 2-57:8 6:9 8:6-8 9:6; 356 2357-9:8; 357 257-9:8;
358 1-3:5-12 4:6-10 56:5-10 7:6-12 89:5-9;
359 2:6-8 35-7:7,8 49:7-9 8:7-9,12; 370 3-9:8; 371 2689:8;
372 36:7 4579:7,8 8:7,8,10; 373 235-9:8; 374 1-9:8; 375 1-4:9 8:6-11 9:10;
376 1:6,8 357-9:6 6:6,9; 377 367:8,9 489:8; 378 0:10 5-7:8;
380 3-7:9 89:9,10; 381 1-3:7-12 6:8-10 78:6-12 9:6-10; 382 2-79:8 8:8,9;
383 2:8,9 3:8-12 489:8; 385 17:8 2-59:8,9 68:7-9; 386 1-7:8 8:5-8 9:6-8;
387 3-57-9:8 6:8,9; 389 2-578:8; 420 2-8:9 9:9-12; 421 2-5:6,7,9 689:7,9;
423 239:7 6-8:7,9; 500 2-7:5; 501 2-8:7; 502 1:11 2-8:8;
503 25-7:8 89:7,11; 504 2379:8 8:8,11; 505 125-8:8; 506 2-7:8 8:8,10 9:10;
507 126:7,8 3-579:7 8:7,8,10,11; 508 2-69:6 78:6,9; 509 2-589:8;
590 5-9:9; 591 2-7:8 8:9; 592 2-9:7; 593 1:10,11 2-7:8 9:9; 594 5-9:9;
595 25:8,9 36-8:6-9 4:7-9 9:6-11; 596 5-9:9; 597 2-4:6 59:6,7 6-8:7;
598 1:8 2:4,5,8 49:7,8 8:7; 599 3467:7 9:8; 670 2-489:7 7:7,8; 672 13:6;
673 2-578:7; 674 24-9:7; 675 1-69:7 7:8 8:7,8; 676 2-4:5 5-8:5,7 9:7;
677 1-35:5 469:5,7 78:7; 678 24:5 389:5,7 57:7; 679 2-9:7; 680 2-9:7;
681 479:6 8:6,9; 682 2-578:5; 683 47:4 568:4,7;
685 2-6:5,6 7:7,10 8:6,7,10; 686 2-8:5,8; 687 2-57-9:6; 688 2:5 79:6,7;
689 4:6,8 8:8,9; 690 2-47:4-7; 691 389:7; 692 2-6:7; 800 1-9:8; 808 1-9:8;
850 1-8:8,10; 852 2-7:8 8:8,9 9:5-8,11; 853 268:8; 855 1:8-10 2-9:8,9;
856 2:8,10 3:8-10 4-8:8; 870 2:9 35-7:9,12; 878 1:12;
880 1:10 2:7-10 3-9:6-10; 881 0-37-9:9 6:9,10;
882 13:7-12 2:10-12 4:8-12 5:9-12 9:8-10; 883 1-5:8-12;
886 2:7-9 3-68:8,9 7:8-11 9:9; 888 1-9:11; 960 3467:7 8:10 9:7,10;
961 1-9:7,8; 962 235689:8 47:9; 963 1-5:8,9 9:9; 964 1:8 2-6:8,9 7:10;
965 1:7 24-69:8; 966 159:9 8:10; 967 1:7,8 2-6:7 7:7,9;
968 1279:8 5:7,8 8:7-9; 970 1:10 2489:8 5:9; 972 1:7,8,10-12 2-489:8 57:9;
973 136-9:8; 974 2:7 3-7:8 8:7,9,11; 975 1:8 2-6:7 78:7,8;
976 12:8-10 5-9:8; 977 1:8,11 2-8:8 9:8,10; 979 1359:9; 992 0-9:9;
993 1-7:8; 994 1-9:9; 995 3-578:9; 996 235-79:9 8:9,10; 998 235-9:9;
`;

interface PlanRule {
  /** Digits a national number may start with. */
  first: string;
  lengths: number[];
}

function expandDigits(spec: string): string {
  let out = '';
  for (let i = 0; i < spec.length; i++) {
    if (spec[i + 1] === '-') {
      for (let d = Number(spec[i]); d <= Number(spec[i + 2]); d++) out += d;
      i += 2;
    } else {
      out += spec[i];
    }
  }
  return out;
}

function expandLengths(spec: string): number[] {
  return spec.split(',').flatMap((part) => {
    const [from, to = from] = part.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  });
}

const PLAN: ReadonlyMap<string, PlanRule[]> = new Map(
  NUMBERING_PLAN.split(';')
    .map((entry) => entry.trim().split(/\s+/))
    .filter(([code]) => code)
    .map(([code, ...rules]): [string, PlanRule[]] => [
      code,
      rules.map((rule) => {
        const [first, lengths] = rule.split(':');
        return { first: expandDigits(first), lengths: expandLengths(lengths) };
      }),
    ])
);

/** The calling code `digits` starts with, or null when none does. */
function countryCodeOf(digits: string): string | null {
  for (let length = 1; length <= 3; length++) {
    const code = digits.slice(0, length);
    if (PLAN.has(code)) return code;
  }
  return null;
}

function fitsPlan(code: string, national: string): boolean {
  if (!national) return false;
  return (PLAN.get(code) ?? []).some(
    (rule) =>
      rule.first.includes(national[0]) && rule.lengths.includes(national.length)
  );
}

function quoted(input: string): string {
  return input.length > 32 ? `"${input.slice(0, 32)}…"` : `"${input}"`;
}

function fail(reason: PhoneValidationReason, error: string): PhoneRejection {
  return { ok: false, reason, error };
}

/**
 * Validate a typed contact number and return it as digits only, in
 * international form (no "+", no "00", no trunk 0 after the country
 * code) — the same form the inbound webhooks store and
 * `phone_normalized` indexes. Validating that form again returns it
 * unchanged.
 *
 * `label` names the number in the error: the default reads well in a
 * form, and the public API passes its field name (`'phone'`, `'to'`).
 */
export function validateContactPhone(
  raw: string,
  label = 'Phone number'
): PhoneValidation {
  const input = (raw ?? '').replace(INVISIBLE_MARKS, '').trim();
  if (!input) return fail('required', `${label} is required`);
  const subject = `${label} ${quoted(input)}`;
  if (input.length > MAX_INPUT_LENGTH) {
    return fail(
      'too_long',
      `${subject} is longer than ${MAX_INPUT_LENGTH} characters. Enter one number with its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }

  if (SCIENTIFIC_NOTATION.test(input)) {
    return fail(
      'scientific_notation',
      `${subject} is in spreadsheet scientific notation and has lost digits. Format the phone column as text and enter the full number with its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }
  if (DECIMAL_SUFFIX.test(input)) {
    return fail(
      'malformed',
      `${subject} looks like a spreadsheet number with a decimal part. Format the phone column as text and enter the full number with its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }
  const typed = input.replace(TEL_PREFIX, '');
  const stray = NOT_A_PHONE_CHARACTER.exec(typed);
  if (stray) {
    return fail(
      'malformed',
      `${subject} contains "${stray[0]}". Enter only the digits 0-9 with the country code (spaces and + ( ) - . / are fine), e.g. ${PHONE_EXAMPLE}`
    );
  }

  let digits = normalizePhone(typed);
  // "00" is the international dialling prefix in the UAE and most of
  // the world, so 00971… is +971…, not a local number.
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    return fail(
      'missing_country_code',
      `${subject} has no country code. Replace the leading 0 with the country code, e.g. ${PHONE_EXAMPLE}`
    );
  }

  if (digits.startsWith(UAE)) {
    let national = digits.slice(UAE.length);
    // "+971 050 …" keeps the trunk 0 that is only dialled at home;
    // WhatsApp's address for that number has no 0.
    if (national.startsWith('0')) national = national.slice(1);
    if (
      UAE_MOBILE.test(national) ||
      UAE_LANDLINE.test(national) ||
      UAE_SERVICE.test(national)
    ) {
      return { ok: true, normalized: UAE + national };
    }
    return fail(
      'invalid_uae',
      `${subject} is not a valid UAE number. Enter +971 and the 9-digit mobile number starting with 5, e.g. ${PHONE_EXAMPLE} (a landline is +971 and 8 digits)`
    );
  }

  // The same trunk 0 after any other country code: "+44 (0)7700 …",
  // "+966 050 …". It is dropped only when the number does not fit the
  // plan with it and does without it, so where numbers really begin
  // with 0 (Italy's "+39 06 …") the 0 stays.
  const code = countryCodeOf(digits);
  if (code) {
    const national = digits.slice(code.length);
    if (
      national.startsWith('0') &&
      !fitsPlan(code, national) &&
      fitsPlan(code, national.slice(1))
    ) {
      digits = code + national.slice(1);
    }
  }

  if (digits.length < MIN_DIGITS) {
    return fail(
      'too_short',
      `${subject} is too short. Include the country code, e.g. ${PHONE_EXAMPLE}`
    );
  }
  if (digits.length > MAX_DIGITS) {
    return fail(
      'too_long',
      `${subject} has more than ${MAX_DIGITS} digits. Enter one number with its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }

  if (!code) {
    return fail(
      'invalid_number',
      `${subject} does not start with a country code. Enter the number with its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }
  if (!fitsPlan(code, digits.slice(code.length))) {
    return fail(
      'invalid_number',
      `${subject} is not a valid number for country code +${code}, which its first digits spell. If it is a local number, add its country code, e.g. ${PHONE_EXAMPLE}`
    );
  }

  return { ok: true, normalized: digits };
}

export type PhoneToSave =
  { ok: true; phone: string; changed: boolean } | PhoneRejection;

/**
 * The value a person's save should write, given the contact's stored
 * number (`original`; null for a new contact). A number whose digits
 * did not change is written back as typed and not validated: many rows
 * were created by an inbound message and carry the gateway's number,
 * and rows saved before this rule existed must stay editable (renaming
 * a contact must not demand a phone fix first). A new or changed
 * number is validated and stored normalized.
 */
export function validatePhoneToSave(
  original: string | null | undefined,
  raw: string
): PhoneToSave {
  const input = (raw ?? '').trim();
  if (!input) return fail('required', 'Phone number is required');
  if (original && normalizePhone(original) === normalizePhone(input)) {
    return { ok: true, phone: input, changed: false };
  }
  const checked = validateContactPhone(input);
  if (!checked.ok) return checked;
  return { ok: true, phone: checked.normalized, changed: true };
}

/**
 * A locally written UAE mobile ("050 123 4567", "0501234567", or the
 * bare "501234567") with 971 in front, ready for `validateContactPhone`.
 * Anything else comes back unchanged, to be validated — or refused —
 * as it is: international numbers, landlines, cells holding two
 * numbers, an email typed into the phone column.
 *
 * Opt-in only, never applied by default. This is the one local shape
 * whose country is assumed, and only because the person uploading the
 * file says so; elsewhere a number without its country code is refused
 * rather than guessed.
 */
export function withUaeCountryCode(raw: string): string {
  const input = raw.replace(INVISIBLE_MARKS, '').trim();
  if (!/^[\d\s\-.()/\u2010-\u2015\u2212]+$/.test(input)) return raw;
  const digits = input.replace(/\D/g, '');
  return /^0?5\d{8}$/.test(digits) ? `971${digits.slice(-9)}` : raw;
}

export interface RejectedPhoneRow<T> {
  /** Position in the input array. */
  index: number;
  row: T;
  reason: PhoneValidationReason;
  error: string;
}

/**
 * Split imported rows into ones with a usable number — returned with
 * `phone` replaced by the normalized digits, so in-file de-dupe and the
 * existing-contact check see "+971 050…" and "971 50…" as one number —
 * and ones to report back to the person importing.
 */
export function partitionRowsByPhone<T extends { phone: string }>(
  rows: T[]
): { valid: T[]; rejected: RejectedPhoneRow<T>[] } {
  const valid: T[] = [];
  const rejected: RejectedPhoneRow<T>[] = [];
  rows.forEach((row, index) => {
    const checked = validateContactPhone(row.phone);
    if (checked.ok) {
      valid.push({ ...row, phone: checked.normalized });
    } else {
      rejected.push({
        index,
        row,
        reason: checked.reason,
        error: checked.error,
      });
    }
  });
  return { valid, rejected };
}

/** One line for a toast: the first problem, plus how many more. */
export function summarizeRejectedPhones(
  rejected: ReadonlyArray<{ error: string }>
): string {
  if (rejected.length === 0) return '';
  const more = rejected.length - 1;
  return more > 0 ? `${rejected[0].error} (+${more} more)` : rejected[0].error;
}
