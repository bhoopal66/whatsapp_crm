/**
 * Ported from wacrm module 019b (CRM memory), reference package 2026-10-18.
 * Pure PII redaction for CRM memory (module 019b). Runs BEFORE storage and before any embedding.
 *   redact(text) -> { ok: true, text, redactions } | { ok: false, refused: true, reason }
 * Never throws: any internal error (or a non-string input) yields the refusal, and the store then saves nothing.
 *
 * Detection runs on a normalised view of the text, built one code point at a time: Default_Ignorable_Code_Point and
 * format (Cf) characters (zero-width space / joiners, soft hyphen, bidi marks) are dropped, every other code point is
 * NFKC-normalised (fullwidth and mathematical digits, fullwidth '@', NBSP), and every Unicode decimal digit (\p{Nd}) is
 * folded to ASCII. The view keeps, per UTF-16 unit, the range of the original code point it came from, so each match is
 * mapped back and the replacement is applied to the ORIGINAL text: text outside a redacted span is stored as given.
 * Patterns run in priority order; a later pattern never touches a span an earlier one claimed:
 *   [EMAIL]    any address, masked fully
 *   [IBAN]     AE + 21 digits, or a generic IBAN that passes the ISO 13616 mod-97 check
 *   [EID]      UAE Emirates ID 784-YYYY-NNNNNNN-N
 *   [CARD]     13..19 digits that pass the Luhn check; not after '+', not starting with 0; when separated, every digit
 *              group but the last has 4+ digits (so dates, date ranges and phone pairs are not cards)
 * IBAN, EID and CARD accept 0..3 separators (whitespace incl. NBSP, '.', '-', any dash, minus, '_', '/') between
 * characters. For IBAN and CARD every group start inside a greedy match is tried (longest valid span wins), and a rejected
 * match is re-scanned from its next character, so a number in front ('AED 500 4111 ...') does not hide the card behind it.
 *   [OTP]      3..8 digits after OTP / PIN / CVV / CVC / passcode / verification-code cues (English and Arabic); the
 *              cue may touch the digits (OTP482913) and up to 3 words may sit between ("OTP for login is ...")
 *   [ACCT]     6..20 digits after account / acc no / a/c / acct cues (English and Arabic)
 *   [PASSPORT] passport number after a passport cue (English and Arabic)
 *   [PHONE:nnn] a full phone number (+ / 00 international, bare or spaced 971 WhatsApp id, UAE 0x local, or (0x)
 *              parenthesised local) keeping its last 3 digits; separators are space, '-', '.', '/' and any dash (bare 971:
 *              space and dashes only). A local number using a separator other than space or '-' needs 3+ digits in every
 *              group after the first (so unspaced date ranges are not phones)
 * Cue words themselves are kept, only the value is replaced.
 * A final catch-all pass (019c) redacts as [CARD] any maximal run of digits, separators and parentheses (optional leading
 * '+') outside the spans above whose digits, without a leading '00', are a card (see cardRun): '+4111111111111111',
 * '(4111) 1111 1111 1111', a card glued to a 971 prefix or an IBAN. Then (019c H-B) a [PHONE:nnn] / [ACCT] span that stops
 * inside a longer card is widened to the whole run and redacted as [CARD] (see wholeRunCards): '+4111 1111 1111 1111',
 * 'card 004111 1111 1111 1111', '+971 4111 1111 1111 1111'.
 */

export type RedactionType =
  'EMAIL' | 'IBAN' | 'EID' | 'CARD' | 'OTP' | 'ACCT' | 'PASSPORT' | 'PHONE';
export type RedactionCounts = Partial<Record<RedactionType, number>>;
export type RedactResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly redactions: RedactionCounts;
    }
  | { readonly ok: false; readonly refused: true; readonly reason: string };

/** Arabic-Indic and Extended Arabic-Indic digits to ASCII; same length as the input. */
export function foldDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0x0f) % 10));
}

const digitsOnly = (s: string) => s.replace(/\D/g, '');

const ND = /^\p{Nd}$/u;
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const ndCache = new Map<number, string>();
/** ASCII value of a \p{Nd} code point. Unicode assigns decimal digits only in contiguous runs of whole groups of ten
 *  (0..9 ascending), so the value is the offset from the start of the run, mod 10. */
function asciiDigit(cp: number): string {
  let d = ndCache.get(cp);
  if (d === undefined) {
    let start = cp;
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
    d = String((cp - start) % 10);
    ndCache.set(cp, d);
  }
  return d;
}

/** The detection view: `from[k]` / `to[k]` are the original UTF-16 range of the code point view unit k came from. */
interface View {
  text: string;
  from: number[];
  to: number[];
}
function detectionView(input: string): View {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < input.length;) {
    const cp = input.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const norm =
      cp < 0x80
        ? input[i]!
        : input
            .slice(i, i + len)
            .normalize('NFKC')
            .replace(IGNORABLE, '')
            .replace(/\p{Nd}/gu, (c) => asciiDigit(c.codePointAt(0)!));
    for (let k = 0; k < norm.length; k++) {
      from.push(i);
      to.push(i + len);
    }
    text += norm;
    i += len;
  }
  return { text, from, to };
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(SEP_CHARS_G, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

interface Rule {
  type: RedactionType;
  re: RegExp;
  /** Index of the capture group holding the value (0 = whole match). */
  group: number;
  /** The accepted [start, end) inside value, or null to reject (the match is then re-scanned from its next char). */
  refine?: (value: string) => readonly [number, number] | null;
  token?: (value: string) => string;
}

/** A greedy match may run into a number or word before or after the real value: try every span that starts at a group
 *  start accepted by startOk and ends at a group end; the longest accepted span wins (earliest on a tie). */
function bestSpan(
  value: string,
  startOk: (rest: string) => boolean,
  ok: (span: string) => boolean
): readonly [number, number] | null {
  const isSep = (i: number) => SEP_CHAR.test(value[i]!);
  const starts: number[] = [];
  const ends: number[] = [value.length];
  for (let i = 0; i < value.length; i++) {
    if (!isSep(i) && (i === 0 || isSep(i - 1)) && startOk(value.slice(i)))
      starts.push(i);
    if (i > 0 && isSep(i) && !isSep(i - 1)) ends.push(i);
  }
  let best: readonly [number, number] | null = null;
  for (const s of starts) {
    for (const e of ends) {
      if (
        e > s &&
        (!best || e - s > best[1] - best[0]) &&
        ok(value.slice(s, e))
      )
        best = [s, e];
    }
  }
  return best;
}

/** Separator characters: whitespace, '.', '-', '_', '/', every dash (\p{Pd}), minus sign U+2212, non-breaking hyphen U+2011.
 *  Regexes built from these need the u flag. */
const SEP_CLASS = '[\\s.\\-_\\/\\p{Pd}\\u2212\\u2011]';
const SEP_CHAR = new RegExp(SEP_CLASS, 'u');
const SEP_CHARS_G = new RegExp(`${SEP_CLASS}+`, 'gu');
/** 0..3 separator characters between two characters of a card, EID or IBAN. */
const SEP = `${SEP_CLASS}{0,3}`;

function cardOk(span: string): boolean {
  const d = digitsOnly(span);
  if (d.length < 13 || d.length > 19 || !luhnValid(d)) return false;
  const groups = span.split(SEP_CHARS_G);
  return groups.slice(0, -1).every((g) => g.length >= 4);
}
const AR_DIGIT_BOUNDARY = '(?<![0-9])';

/** Card catch-all (019c): a maximal run of digits joined by separators or parentheses, with an optional leading '+' and
 *  an optionally parenthesised first group ('(4111) 1111 ...'). */
const RUN_SEP_CLASS = SEP_CLASS.slice(0, -1) + '()]';
const RUN_SEPS_G = new RegExp(`${RUN_SEP_CLASS}+`, 'gu');
const RUN_RE = new RegExp(
  `\\+?(?:\\([0-9]+\\)|[0-9])(?:${RUN_SEP_CLASS}*[0-9])*`,
  'gu'
);

/** A digit run is a card when its digits, without a leading '00', are 13..19, Luhn-valid and not an Emirates ID shape
 *  (784 + 15 digits). For the catch-all (`glued`): every group but the last must also have 4+ digits (so date ranges are
 *  not cards), or a 16-digit (IIN 2..6) / 15-digit (IIN 34 / 37) Luhn-valid prefix or suffix of a longer run is a card
 *  glued to another number ('9714111111111111111', an IBAN followed by a card). */
function cardRun(run: string, glued: boolean): boolean {
  let d = digitsOnly(run);
  if (d.startsWith('00')) d = d.slice(2);
  const pan =
    d.length >= 13 &&
    d.length <= 19 &&
    luhnValid(d) &&
    !(d.length === 15 && d.startsWith('784'));
  if (!glued) return pan;
  if (
    pan &&
    run
      .split(RUN_SEPS_G)
      .filter(Boolean)
      .slice(0, -1)
      .every((g) => digitsOnly(g).length >= 4)
  )
    return true;
  for (const [len, iin] of [
    [16, /^[2-6]/],
    [15, /^3[47]/],
  ] as const) {
    if (d.length > len)
      for (const w of [d.slice(0, len), d.slice(-len)])
        if (iin.test(w) && luhnValid(w)) return true;
  }
  return false;
}

/** The catch-all pass: every maximal digit run outside the claimed spans that is a card, as view [start, end). */
function cardRuns(
  folded: string,
  claimed: readonly { start: number; end: number }[]
): Array<readonly [number, number]> {
  let masked = folded;
  for (const s of claimed)
    masked =
      masked.slice(0, s.start) +
      'x'.repeat(s.end - s.start) +
      masked.slice(s.end);
  const out: Array<readonly [number, number]> = [];
  for (const m of masked.matchAll(RUN_RE))
    if (cardRun(m[0], true)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Whole-run card claim (019c H-B): a PHONE or ACCT span can stop inside a longer card written with a leading '+' / '00'
 *  ('+4111 1111 1111 1111' gives a 12-digit phone, '1111' left over). For each maximal digit run (RUN_RE on the unmasked
 *  view) holding exactly one PHONE / ACCT span and no other span but CARD, the range covering the run and its spans is
 *  one card when its digits, or its digits after a leading '+' / '00' and '971', pass cardRun without glued windows (a
 *  glued window would fold a phone next to an already-claimed card). A run holding two values (two phones side by side)
 *  is left alone. Returns the card ranges, view [start, end). */
function wholeRunCards(
  folded: string,
  spans: readonly { start: number; end: number; type: RedactionType }[]
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const m of folded.matchAll(RUN_RE)) {
    const inside = spans.filter(
      (x) => x.start < m.index + m[0].length && x.end > m.index
    );
    const values = inside.filter((x) => x.type !== 'CARD');
    if (
      values.length !== 1 ||
      (values[0]!.type !== 'PHONE' && values[0]!.type !== 'ACCT')
    )
      continue;
    const start = Math.min(m.index, ...inside.map((x) => x.start));
    const end = Math.max(m.index + m[0].length, ...inside.map((x) => x.end));
    const run = folded.slice(start, end);
    if (
      cardRun(run, false) ||
      cardRun(run.replace(/^\+?(?:00)?971/, ''), false)
    )
      out.push([start, end]);
  }
  return out;
}

const RULES: readonly Rule[] = [
  {
    type: 'EMAIL',
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
    group: 0,
  },
  {
    type: 'IBAN',
    re: new RegExp(`(?<![A-Za-z0-9])AE(?:${SEP}[0-9]){21}(?![0-9])`, 'giu'),
    group: 0,
  },
  {
    type: 'IBAN',
    re: new RegExp(
      `(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:${SEP}[A-Za-z0-9]){11,30}(?![A-Za-z0-9])`,
      'gu'
    ),
    group: 0,
    refine: (v) =>
      bestSpan(v, (r) => /^[A-Za-z]{2}[0-9]{2}/.test(r), ibanValid),
  },
  {
    type: 'EID',
    re: new RegExp(
      `${AR_DIGIT_BOUNDARY}784${SEP}[0-9]{4}${SEP}[0-9]{7}${SEP}[0-9](?![0-9])`,
      'gu'
    ),
    group: 0,
  },
  {
    type: 'CARD',
    re: new RegExp(`(?<![0-9+])[1-9](?:${SEP}[0-9]){12,18}(?![0-9])`, 'gu'),
    group: 0,
    refine: (v) => bestSpan(v, (r) => /^[1-9]/.test(r), cardOk),
  },
  {
    type: 'OTP',
    re: /(?:\b(?:otp|pin|cvv2?|cvc|passcode|one[- ]time (?:password|code|pin)|verification code|security code|auth(?:entication)? code)(?!\p{L})|\u0631\u0645\u0632 \u0627\u0644\u062a\u062d\u0642\u0642|\u0631\u0645\u0632 \u0627\u0644\u062a\u0641\u0639\u064a\u0644|\u0627\u0644\u0631\u0642\u0645 \u0627\u0644\u0633\u0631\u064a|\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631|\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631|\u0627\u0644\u0631\u0645\u0632|\u0631\u0645\u0632)[\s:=#.\-]*(?:(?:code|number|no|is|was|\u0647\u0648)[\s:=#.\-]*)*(?:\p{L}+[\s:=#.\-]+){0,3}([0-9]{3,8})(?![0-9])/giu,
    group: 1,
  },
  {
    type: 'ACCT',
    re: /(?:\b(?:account|acc|acct|a\/c)\b|رقم الحساب|الحساب|حساب)[\s:=#.\-]*(?:(?:number|num|no|is|رقم)[\s:=#.\-]*)*([0-9](?:[ -]?[0-9]){5,19})(?![0-9])/giu,
    group: 1,
  },
  {
    type: 'PASSPORT',
    re: /(?:\bpassport\b|جواز السفر|جواز)[\s:=#.\-]*(?:(?:number|num|no|is|رقم)[\s:=#.\-]*)*([A-Za-z]{0,2}[0-9]{6,9})(?![0-9A-Za-z])/giu,
    group: 1,
  },
  {
    type: 'PHONE',
    re: /(?<![0-9])(?:\+|00)[1-9](?:[ .\/\-()\p{Pd}]{0,2}[0-9]){7,13}(?![0-9])|(?<![0-9+])971(?:[ \-\p{Pd}]?[0-9]){8,9}(?![0-9])|(?<![0-9+])\(0[1-9][0-9]?\)[ .\/\-\p{Pd}]?[0-9](?:[ .\/\-\p{Pd}]?[0-9]){6}(?![0-9])|(?<![0-9+])0[1-9](?:[ .\/\-\p{Pd}]?[0-9]){7,8}(?![0-9])/gu,
    group: 0,
    // A local value (0x or (0x)) written with any separator other than space or '-' must have 3+ digits in every group
    // after the first, so an unspaced date range (01/02/2024-05/02/2024, 05.01.2024-06.01.2024) is not a phone.
    refine: (v) =>
      /^(?:0[1-9]|\()/.test(v) &&
      /[^0-9 \-()]/.test(v) &&
      !v
        .match(/[0-9]+/g)!
        .slice(1)
        .every((g) => g.length >= 3)
        ? null
        : [0, v.length],
    token: (v) => `[PHONE:${digitsOnly(v).slice(-3)}]`,
  },
];

export function redact(input: string): RedactResult {
  try {
    if (typeof input !== 'string')
      return { ok: false, refused: true, reason: 'content is not a string' };
    const view = detectionView(input);
    const folded = view.text;
    let spans: {
      start: number;
      end: number;
      token: string;
      type: RedactionType;
    }[] = [];
    const counts: RedactionCounts = {};
    const overlaps = (s: number, e: number) =>
      spans.some((x) => s < x.end && e > x.start);
    for (const rule of RULES) {
      const re = new RegExp(
        rule.re.source,
        rule.re.flags.includes('d') ? rule.re.flags : rule.re.flags + 'd'
      );
      for (let m = re.exec(folded); m; m = re.exec(folded)) {
        const idx = m.indices?.[rule.group];
        const value = m[rule.group];
        if (!idx || value === undefined) continue;
        const span = rule.refine
          ? rule.refine(value)
          : ([0, value.length] as const);
        const start = idx[0] + (span ? span[0] : 0);
        const end = idx[0] + (span ? span[1] : 0);
        if (end <= start || overlaps(start, end)) {
          if (rule.refine) re.lastIndex = m.index + 1; // re-anchor: a value may start later inside this match
          continue;
        }
        if (rule.refine) re.lastIndex = end;
        spans.push({
          start,
          end,
          token: rule.token
            ? rule.token(folded.slice(start, end))
            : `[${rule.type}]`,
          type: rule.type,
        });
        counts[rule.type] = (counts[rule.type] ?? 0) + 1;
      }
    }
    for (const [start, end] of cardRuns(folded, spans)) {
      spans.push({ start, end, token: '[CARD]', type: 'CARD' });
      counts.CARD = (counts.CARD ?? 0) + 1;
    }
    for (const [start, end] of wholeRunCards(folded, spans)) {
      for (const x of spans.filter((x) => x.start < end && x.end > start)) {
        counts[x.type] = counts[x.type]! - 1;
        if (counts[x.type] === 0) delete counts[x.type];
      }
      spans = spans.filter((x) => !(x.start < end && x.end > start));
      spans.push({ start, end, token: '[CARD]', type: 'CARD' });
      counts.CARD = (counts.CARD ?? 0) + 1;
    }
    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const s of spans) {
      // A view span maps to whole original code points; two spans can share one only inside an NFKC expansion.
      const start = Math.max(view.from[s.start]!, at);
      out += input.slice(at, start) + s.token;
      at = Math.max(view.to[s.end - 1]!, at);
    }
    out += input.slice(at);
    return { ok: true, text: out, redactions: counts };
  } catch (e) {
    return {
      ok: false,
      refused: true,
      reason: `redaction failed: ${e instanceof Error ? e.name : 'error'}`,
    };
  }
}
