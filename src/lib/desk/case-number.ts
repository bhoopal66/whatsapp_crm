/**
 * Case desk numbers (migration 220), identical to its SQL
 * (`desk_check_char`, `desk_case_number`, `desk_caption_code`):
 *
 *   case number   'TC-YY-NNNNN-BBB'; the second .. ninth case of one
 *                 application at the same bank is BBB2 .. BBB9. NNNNN is
 *                 the account's application counter (1 .. 9999999, never
 *                 restarts), zero-padded to at least 5 digits; YY is the
 *                 opening year, display only.
 *   caption code  seq without leading zeros + BBB(+digit) + one check
 *                 character, e.g. '1RAK1'.
 *   check char    Luhn mod 36 over NNNNN + BBB(+digit) (no YY, so the
 *                 typed code carries everything the check covers),
 *                 alphabet 0-9A-Z, weights 2,1,2,... from the right, each
 *                 product reduced as floor(x/36) + x%36,
 *                 check = (36 - sum%36) % 36.
 *
 * supabase/ci/verify-case-desk.sql pins the same vectors as the test.
 */

export const CHECK_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const MAX_SEQ = 9999999;

const CASE_NUMBER =
  /^TC-([0-9]{2})-([0-9]{5}|[1-9][0-9]{5,6})-([A-Z]{3})([2-9]?)$/;
const CAPTION = /^([1-9][0-9]{0,6})([A-Z]{3}[2-9]?)([0-9A-Z])$/;
const BANK_PART = /^[A-Z]{3}[2-9]?$/;

export interface CaseNumberParts {
  yy: number;
  seq: number;
  bank: string;
  slot: number;
  bankPart: string;
}

export interface CaptionParts {
  seq: number;
  bankPart: string;
  check: string;
}

/** The check character of a 0-9A-Z payload; RangeError otherwise (SQL: NULL). */
export function checkChar(payload: string): string {
  if (!/^[0-9A-Z]+$/.test(payload))
    throw new RangeError('checkChar: payload must be 0-9A-Z');
  let f = 2;
  let s = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    const ad = f * CHECK_ALPHABET.indexOf(payload[i]!);
    s += Math.floor(ad / 36) + (ad % 36);
    f = 3 - f;
  }
  return CHECK_ALPHABET[(36 - (s % 36)) % 36]!;
}

function assertSeqBank(seq: number, bankPart: string): void {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ)
    throw new RangeError(`seq: 1..${MAX_SEQ}`);
  if (!BANK_PART.test(bankPart))
    throw new RangeError(
      'bankPart: three letters A-Z and an optional digit 2-9'
    );
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const payloadOf = (seq: number, bankPart: string) => pad(seq, 5) + bankPart;

/** 'TC-26-00001-RAK' */
export function formatCaseNumber(
  yy: number,
  seq: number,
  bankPart: string
): string {
  if (!Number.isInteger(yy) || yy < 0 || yy > 99)
    throw new RangeError('yy: 0..99');
  assertSeqBank(seq, bankPart);
  return `TC-${pad(yy, 2)}-${pad(seq, 5)}-${bankPart}`;
}

export function parseCaseNumber(s: string): CaseNumberParts | null {
  const m = CASE_NUMBER.exec(s);
  if (!m) return null;
  const seq = Number(m[2]);
  if (seq < 1) return null;
  return {
    yy: Number(m[1]),
    seq,
    bank: m[3]!,
    slot: m[4] ? Number(m[4]) : 1,
    bankPart: m[3]! + m[4]!,
  };
}

/** '1RAK1' for (1, 'RAK') */
export function captionCode(seq: number, bankPart: string): string {
  assertSeqBank(seq, bankPart);
  return String(seq) + bankPart + checkChar(payloadOf(seq, bankPart));
}

/** A caption code as typed (any case, spaces ignored), or null when malformed or the check fails. */
export function parseCaption(code: string): CaptionParts | null {
  const m = CAPTION.exec(code.replace(/\s+/g, '').toUpperCase());
  if (!m) return null;
  const seq = Number(m[1]);
  const bankPart = m[2]!;
  const check = m[3]!;
  if (checkChar(payloadOf(seq, bankPart)) !== check) return null;
  return { seq, bankPart, check };
}

/** The caption code of a full case number, or null when it is not one. */
export function captionCodeOf(caseNumber: string): string | null {
  const p = parseCaseNumber(caseNumber);
  return p ? captionCode(p.seq, p.bankPart) : null;
}
