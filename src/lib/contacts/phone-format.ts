/**
 * Display formatting for contact phone numbers: `+971 50 123 4401`.
 *
 * Display only. Never store the result or send it to a gateway: the
 * stored `phone` and `phone_normalized` stay as they are
 * (`phone-validation.ts` owns entry rules). The country code is found
 * by longest-prefix match on the calling codes below; a number with no
 * known code, too few digits or no digits at all is shown as typed
 * rather than guessed at.
 */

/** Calling codes we know the grouping of, or at least recognise. */
const CALLING_CODES = new Set([
  '1',
  '7',
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
  '212',
  '213',
  '216',
  '218',
  '220',
  '234',
  '249',
  '251',
  '254',
  '255',
  '256',
  '351',
  '352',
  '353',
  '354',
  '355',
  '358',
  '359',
  '370',
  '371',
  '372',
  '380',
  '381',
  '385',
  '386',
  '420',
  '421',
  '852',
  '853',
  '855',
  '880',
  '886',
  '961',
  '962',
  '963',
  '964',
  '965',
  '966',
  '967',
  '968',
  '970',
  '971',
  '972',
  '973',
  '974',
  '975',
  '976',
  '977',
  '992',
  '993',
  '994',
  '995',
  '996',
  '998',
]);

/** National-number group sizes, chosen by the national number's shape. */
function groupsFor(code: string, national: string): number[] | null {
  const n = national.length;
  switch (code) {
    case '971':
      // Mobile 5X XXX XXXX; landline 4 XXX XXXX.
      if (n === 9 && national[0] === '5') return [2, 3, 4];
      if (n === 8) return [1, 3, 4];
      return null;
    case '91':
      return n === 10 ? [5, 5] : null;
    case '44':
      return n === 10 ? [4, 6] : null;
    case '1':
      return n === 10 ? [3, 3, 4] : null;
    default:
      return null;
  }
}

/** Split `digits` into the given sizes; any remainder is a last group. */
function splitBy(digits: string, sizes: readonly number[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= digits.length) break;
    out.push(digits.slice(at, at + size));
    at += size;
  }
  if (at < digits.length) out.push(digits.slice(at));
  return out;
}

/** Groups of up to 3-4 digits for a code we cannot group exactly. */
function genericSizes(n: number): number[] {
  if (n <= 4) return [n];
  const sizes: number[] = [];
  let left = n;
  while (left > 4) {
    sizes.push(3);
    left -= 3;
  }
  sizes.push(left);
  return sizes;
}

function internationalDigits(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  // A leading 0 is a national trunk prefix: no country, so not international.
  if (digits.startsWith('0')) return null;
  return digits;
}

/** The country code at the front of `digits`, longest match first. */
function countryCodeOf(digits: string): string | null {
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (code.length === len && CALLING_CODES.has(code)) return code;
  }
  return null;
}

/**
 * The number as `+<code> <groups>`, or the input trimmed when it cannot
 * be read as an international number (short, local-format, garbage).
 */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  const digits = internationalDigits(raw);
  if (!digits || digits.length < 8 || digits.length > 15) return raw;
  const code = countryCodeOf(digits);
  if (!code) return raw;
  let national = digits.slice(code.length);
  // "+971 050 123 4401": a trunk 0 typed after the country code.
  if (national.startsWith('0') && ['971', '44', '91'].includes(code)) {
    national = national.slice(1);
  }
  if (national.length < 4) return raw;
  const sizes = groupsFor(code, national) ?? genericSizes(national.length);
  return `+${code} ${splitBy(national, sizes).join(' ')}`;
}

/**
 * The raw international number to copy (`+971501234401`), or the
 * trimmed input when it has no country code to put a `+` on.
 */
export function phoneForCopy(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  const digits = internationalDigits(raw);
  if (!digits || digits.length < 8 || digits.length > 15) return raw;
  return `+${digits}`;
}
