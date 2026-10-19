/**
 * Ported from wacrm module 019c (vault), reference package 2026-10-18.
 * `workspace` (TokenVault.put, TokenizeContext) keeps the reference name but means the wacrm account id (accounts.id).
 * Vault tokenisation for free text (module 019c): run BEFORE the 019b memory put, on the ORIGINAL text.
 *   tokenizeSensitive(text, { workspace, subject, actor }, vault, redactImpl = redact)
 *     -> { ok: true, text, vaulted } | { ok: false, reason }
 * Spans that 019b redaction would replace with [EID] / [IBAN] / [PASSPORT] / [PHONE:nnn] / [ACCT] are stored in the
 * vault (vault.put, kinds EID / IBAN / PASSPORT / PHONE / ACCOUNT) and replaced by '[KIND:vlt_...]'. Everything else
 * redaction catches stays redacted exactly as redactImpl writes it: [EMAIL], and [CARD] / [OTP] (which covers PIN, CVV,
 * CVC) are NEVER vaulted (PCI-DSS: no card number, CVV, OTP or PIN is stored, even encrypted).
 *
 * src/lib/memory/redact.ts does not export its spans, so its detection view and rules are copied here in the SAME priority
 * order (EMAIL, IBAN, EID, CARD, OTP, ACCT, PASSPORT, PHONE): CARD and OTP claim their spans before ACCT / PASSPORT /
 * PHONE, so 'account 4111 1111 1111 1111' is a card and is not vaulted as an account. A card number the card rule misses
 * (a digit group shorter than 4, a leading '+': 'account 41 1111 1111 1111 11', 'card +4222222222222') is claimed by
 * ACCT or PHONE; before any ACCOUNT / PHONE put the span's digits are checked, and 13-19 Luhn-valid digits are written
 * as [CARD] and never vaulted. A card that ACCT or PHONE claims only in part ('card +4111 1111 1111 1111': a 12-digit
 * phone, '1111' left over) is claimed whole by wholeRunCards (copied from redact(), which applies the same claim) and
 * written as [CARD] with no put. src/lib/vault/tokenize.test.ts holds
 * a parity corpus against redact() so drift between the two copies fails the suite.
 *
 * Method: detect spans on the normalised view, map each back to the original text (as redact does), vault every
 * vault-kind span, replace each with a private-use sentinel (U+E000 + n), run redactImpl on the result (it redacts the
 * rest; the sentinels are not letters, digits or separators to any rule), then swap each sentinel for '[KIND:token]'.
 * Fails closed: input that already holds a private-use character is refused; any vault.put failure (including a value
 * the vault's normaliser rejects), a redactImpl refusal or a sentinel that does not survive exactly once yields
 * { ok: false } and no text. Items put before a later failure stay in the vault (unreferenced). A reason never carries
 * a value.
 */
import {
  ibanValid,
  luhnValid,
  redact,
  type RedactResult,
  type RedactionType,
} from '@/lib/memory/redact';
import type { VaultKind } from './crypto';
import type { VaultSubject } from './types';

export interface TokenVault {
  put(
    workspace: string,
    kind: VaultKind,
    value: string,
    subject: VaultSubject,
    actor: string
  ): Promise<{ token: string; deduped: boolean }>;
}

export interface TokenizeContext {
  readonly workspace: string;
  readonly subject: VaultSubject;
  readonly actor: string;
}

export type TokenizeResult =
  | { readonly ok: true; readonly text: string; readonly vaulted: number }
  | { readonly ok: false; readonly reason: string };

/** Which redaction types are vaulted, and as which vault kind. CARD / OTP / EMAIL: never. */
const VAULTED: Readonly<Record<RedactionType, VaultKind | null>> = {
  EMAIL: null,
  IBAN: 'IBAN',
  EID: 'EID',
  CARD: null,
  OTP: null,
  ACCT: 'ACCOUNT',
  PASSPORT: 'PASSPORT',
  PHONE: 'PHONE',
};

/** Sentinels: U+E000 + n. Any BMP private-use character in the input is refused. */
const SENTINEL_BASE = 0xe000;
const MAX_SENTINELS = 0xf8ff - SENTINEL_BASE + 1;
const PRIVATE_USE = /[\ue000-\uf8ff]/;

// ---- copy of src/lib/memory/redact.ts detection (keep in step; the parity test enforces it) ---------------------------

const digitsOnly = (s: string) => s.replace(/\D/g, '');

const ND = /^\p{Nd}$/u;
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const ndCache = new Map<number, string>();
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

interface Rule {
  type: RedactionType;
  re: RegExp;
  group: number;
  refine?: (value: string) => readonly [number, number] | null;
}

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

const SEP_CLASS = '[\\s.\\-_\\/\\p{Pd}\\u2212\\u2011]';
const SEP_CHAR = new RegExp(SEP_CLASS, 'u');
const SEP_CHARS_G = new RegExp(`${SEP_CLASS}+`, 'gu');
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
    re: /(?:\b(?:account|acc|acct|a\/c)\b|\u0631\u0642\u0645 \u0627\u0644\u062d\u0633\u0627\u0628|\u0627\u0644\u062d\u0633\u0627\u0628|\u062d\u0633\u0627\u0628)[\s:=#.\-]*(?:(?:number|num|no|is|\u0631\u0642\u0645)[\s:=#.\-]*)*([0-9](?:[ -]?[0-9]){5,19})(?![0-9])/giu,
    group: 1,
  },
  {
    type: 'PASSPORT',
    re: /(?:\bpassport\b|\u062c\u0648\u0627\u0632 \u0627\u0644\u0633\u0641\u0631|\u062c\u0648\u0627\u0632)[\s:=#.\-]*(?:(?:number|num|no|is|\u0631\u0642\u0645)[\s:=#.\-]*)*([A-Za-z]{0,2}[0-9]{6,9})(?![0-9A-Za-z])/giu,
    group: 1,
  },
  {
    type: 'PHONE',
    re: /(?<![0-9])(?:\+|00)[1-9](?:[ .\/\-()\p{Pd}]{0,2}[0-9]){7,13}(?![0-9])|(?<![0-9+])971(?:[ \-\p{Pd}]?[0-9]){8,9}(?![0-9])|(?<![0-9+])\(0[1-9][0-9]?\)[ .\/\-\p{Pd}]?[0-9](?:[ .\/\-\p{Pd}]?[0-9]){6}(?![0-9])|(?<![0-9+])0[1-9](?:[ .\/\-\p{Pd}]?[0-9]){7,8}(?![0-9])/gu,
    group: 0,
    refine: (v) =>
      /^(?:0[1-9]|\()/.test(v) &&
      /[^0-9 \-()]/.test(v) &&
      !v
        .match(/[0-9]+/g)!
        .slice(1)
        .every((g) => g.length >= 3)
        ? null
        : [0, v.length],
  },
];

interface Span {
  start: number;
  end: number;
  type: RedactionType;
  card?: boolean;
}

/** All redaction spans on the view, claimed in rule priority order (a later rule never touches an earlier span). */
function detect(folded: string): Span[] {
  const spans: Span[] = [];
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
        if (rule.refine) re.lastIndex = m.index + 1;
        continue;
      }
      if (rule.refine) re.lastIndex = end;
      spans.push({ start, end, type: rule.type });
    }
  }
  for (const [start, end] of cardRuns(folded, spans))
    spans.push({ start, end, type: 'CARD' });
  return spans.sort((a, b) => a.start - b.start);
}

/** Apply wholeRunCards to detect()'s spans: each card range replaces the spans it covers by one span of the PHONE /
 *  ACCT type it absorbed, marked card (so it is staged with a sentinel, written as [CARD] and never put). */
function claimCardRuns(folded: string, spans: Span[]): Span[] {
  let out = spans;
  for (const [start, end] of wholeRunCards(folded, spans)) {
    const inside = out.filter((x) => x.start < end && x.end > start);
    const type = inside.find(
      (x) => x.type === 'PHONE' || x.type === 'ACCT'
    )!.type;
    out = out.filter((x) => !(x.start < end && x.end > start));
    out.push({ start, end, type, card: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- tokenisation ---------------------------------------------------------------------------------------------------

/** The value handed to vault.put: the view slice (NFKC, digits folded) without the separators the rules accept and the
 *  vault normaliser does not; a phone keeps a leading '+'. */
/** 13-19 digits passing Luhn: a card number (PAN), never vaulted. */
function panLike(viewSlice: string): boolean {
  const d = digitsOnly(viewSlice);
  return d.length >= 13 && d.length <= 19 && luhnValid(d);
}

function putValue(kind: VaultKind, viewSlice: string): string {
  if (kind === 'IBAN') return viewSlice.replace(SEP_CHARS_G, '');
  if (kind === 'PASSPORT') return viewSlice;
  if (kind === 'PHONE')
    return (viewSlice.startsWith('+') ? '+' : '') + digitsOnly(viewSlice);
  return digitsOnly(viewSlice);
}

export async function tokenizeSensitive(
  text: string,
  ctx: TokenizeContext,
  vault: TokenVault,
  redactImpl: (input: string) => RedactResult = redact
): Promise<TokenizeResult> {
  if (typeof text !== 'string')
    return { ok: false, reason: 'content is not a string' };
  if (PRIVATE_USE.test(text))
    return { ok: false, reason: 'content contains private-use characters' };
  let view: View;
  let spans: Span[];
  try {
    view = detectionView(text);
    spans = claimCardRuns(view.text, detect(view.text));
  } catch (e) {
    return {
      ok: false,
      reason: `detection failed: ${e instanceof Error ? e.name : 'error'}`,
    };
  }
  const vaultSpans = spans.filter((s) => VAULTED[s.type] !== null);
  if (vaultSpans.length > MAX_SENTINELS)
    return { ok: false, reason: 'too many sensitive values' };

  // Vault every span first: nothing is returned unless every put succeeded. A whole-run card claim, or an ACCOUNT /
  // PHONE span that is a card number, gets [CARD] and no put.
  const placeholders: string[] = [];
  let vaulted = 0;
  for (const s of vaultSpans) {
    const kind = VAULTED[s.type]!;
    const slice = view.text.slice(s.start, s.end);
    if (s.card) {
      placeholders.push('[CARD]');
      continue;
    }
    if ((kind === 'ACCOUNT' || kind === 'PHONE') && panLike(slice)) {
      placeholders.push('[CARD]');
      continue;
    }
    try {
      const { token } = await vault.put(
        ctx.workspace,
        kind,
        putValue(kind, slice),
        ctx.subject,
        ctx.actor
      );
      placeholders.push(`[${kind}:${token}]`);
      vaulted++;
    } catch (e) {
      return {
        ok: false,
        reason: `vault put failed: ${kind}: ${e instanceof Error ? e.name : 'error'}`,
      };
    }
  }

  // Replace vault spans by sentinels in the original text, mapping view spans back exactly as redact() does.
  let staged = '';
  let at = 0;
  let n = 0;
  for (const s of spans) {
    const start = Math.max(view.from[s.start]!, at);
    const end = Math.max(view.to[s.end - 1]!, at);
    // A non-vault span is copied as given, for redactImpl to redact.
    staged +=
      VAULTED[s.type] === null
        ? text.slice(at, end)
        : text.slice(at, start) + String.fromCharCode(SENTINEL_BASE + n++);
    at = end;
  }
  staged += text.slice(at);

  const red = redactImpl(staged);
  if (!red.ok) return { ok: false, reason: red.reason };
  let out = red.text;
  for (let i = 0; i < placeholders.length; i++) {
    const sentinel = String.fromCharCode(SENTINEL_BASE + i);
    const parts = out.split(sentinel);
    if (parts.length !== 2)
      return { ok: false, reason: 'tokenisation failed: placeholder lost' };
    out = parts[0] + placeholders[i]! + parts[1];
  }
  if (PRIVATE_USE.test(out))
    return { ok: false, reason: 'tokenisation failed: stray sentinel' };
  return { ok: true, text: out, vaulted };
}
