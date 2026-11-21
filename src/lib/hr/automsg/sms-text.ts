/**
 * SMS text rules for HR automated messages (package release 032): the
 * encoding a text needs and how many segments it takes. Shared by the
 * Dinstar sender (`dinstar.ts`, which refuses a text over the cap) and
 * the template editor's counter, so the two never disagree.
 *
 * Client components import this file: it imports nothing.
 *
 * - GSM-7 only when every character is in the GSM 03.38 basic set (the
 *   escape table, e.g. '{' or '€', counts as Unicode here, as the
 *   package's sender does); otherwise Unicode (UCS-2).
 * - One segment holds 160 GSM-7 or 70 Unicode characters; a longer text
 *   is split into segments of 153 / 67.
 * - The cap is 3 segments: 459 GSM-7 or 201 Unicode characters. Unicode
 *   length is counted in UTF-16 code units, as UCS-2 sends them.
 */

/** GSM 03.38 basic character set (escape 0x1B and the extension table excluded). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_SET = new Set(GSM7_BASIC);

export type SmsEncoding = 'gsm-7bit' | 'unicode';

export const MAX_SMS_SEGMENTS = 3;
export const SMS_SEGMENT = {
  'gsm-7bit': { single: 160, part: 153 },
  unicode: { single: 70, part: 67 },
} as const;
/** The cap in characters: 3 x 153 and 3 x 67. */
export const MAX_GSM7_CHARS = MAX_SMS_SEGMENTS * SMS_SEGMENT['gsm-7bit'].part;
export const MAX_UCS2_CHARS = MAX_SMS_SEGMENTS * SMS_SEGMENT.unicode.part;

export function smsEncoding(text: string): SmsEncoding {
  for (const ch of text) if (!GSM7_SET.has(ch)) return 'unicode';
  return 'gsm-7bit';
}

export interface SmsMeasure {
  encoding: SmsEncoding;
  /** Characters as the gateway counts them (UTF-16 code units for Unicode). */
  length: number;
  segments: number;
  /** Within MAX_SMS_SEGMENTS. */
  fits: boolean;
}

export function measureSms(text: string): SmsMeasure {
  const encoding = smsEncoding(text);
  const length = text.length;
  const { single, part } = SMS_SEGMENT[encoding];
  const segments =
    length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / part);
  return {
    encoding,
    length,
    segments,
    fits: segments <= MAX_SMS_SEGMENTS,
  };
}
