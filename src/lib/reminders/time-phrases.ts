// ============================================================
// The times a chat message names (reminder suggestions, migration 197).
//
// Jev answers choices, never free text, so it cannot read a date out of
// a message. This finds every time the message names, deterministically,
// as candidate instants; Jev then judges whether the message is
// something to be reminded of and which candidate it means.
//
// Pure: no clock (the caller passes `now`), no I/O, no Intl state beyond
// time-zone arithmetic.
//
// How: the text is normalised 1:1 (digits, Arabic letter variants, case)
// so indices still point into the original; regexes find atoms (a day,
// a clock time, a part of day, a relative offset, a past marker); atoms
// with only filler between them combine into one phrase; each phrase is
// resolved to an instant in `timeZone`.
// ============================================================

/** One time a message names. */
export interface TimeCandidate {
  /** The words as they appear in the message, trimmed, at most 80 chars. */
  phrase: string;
  /** Where the phrase starts in the text (UTF-16 index). */
  index: number;
  /** The instant meant, ISO 8601 in UTC (`toISOString()`). */
  at: string;
  /** A day was named but no time of day: `at` is 09:00 in `timeZone`. */
  dateOnly: boolean;
}

export interface FindTimeOptions {
  /** When the message was written; relative words count from here. */
  now: Date;
  /** IANA zone the words are read in (the account's saved zone, else UTC). */
  timeZone: string;
  /** Most candidates returned, in order of appearance. Default 4. */
  max?: number;
}

/** Every future time the message names, in order of appearance. */
export function findTimePhrases(
  text: string,
  opts: FindTimeOptions
): TimeCandidate[] {
  const max = opts.max ?? 4;
  if (!text || max <= 0) return [];
  const norm = normalise(text);
  const nowMs = opts.now.getTime();
  const today = localDate(nowMs, opts.timeZone);
  const out: TimeCandidate[] = [];
  const seen = new Set<string>();
  for (const g of mergeAtoms(scan(norm), norm)) {
    if (g.day?.t === 'past') continue;
    if (g.needsTime && !g.clock && !g.part) continue;
    if (g.needsAnchor && !g.day && !g.clock) continue;
    const r = resolveGroup(g, nowMs, today, opts.timeZone);
    if (!r || !(r.ms > nowMs)) continue;
    const at = new Date(r.ms).toISOString();
    if (seen.has(at)) continue;
    seen.add(at);
    const raw = text.slice(g.start, g.end);
    const lead = raw.length - raw.trimStart().length;
    out.push({
      phrase: raw.trim().slice(0, MAX_PHRASE).trimEnd(),
      index: g.start + lead,
      at,
      dateOnly: r.dateOnly,
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---- constants ----------------------------------------------------------

/** A day named without a time of day lands here. Equals REMINDER_HOUR in
 *  src/lib/tasks/reminder.ts (not imported, to stay dependency-free;
 *  time-phrases.test.ts pins the two together). */
const DATE_ONLY_HOUR = 9;
const MAX_PHRASE = 80;
/** Most characters of filler between a day and a time that still join. */
const MAX_GAP = 12;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Part =
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'asr'
  | 'maghrib'
  | 'evening'
  | 'night'
  | 'eod';

/** The hour a part of day means when no clock time is given. */
const PART_HOUR: Record<Part, number> = {
  morning: 9,
  noon: 12,
  afternoon: 15,
  asr: 16,
  maghrib: 18,
  evening: 18,
  night: 20,
  eod: 17,
};

interface Clock {
  h: number;
  min: number;
  ampm: 'am' | 'pm' | null;
  /** 24-hour reading: 0, 13-23 or a leading zero ("09:30"). */
  literal: boolean;
  /** Arabic "N الا ربع": a quarter before the hour. */
  quarterTo: boolean;
}

type Day =
  | { t: 'offset'; days: number }
  | { t: 'weekday'; wd: number }
  | { t: 'date'; d: number; m: number; y: number | null }
  | { t: 'dom'; d: number }
  | { t: 'months'; n: number }
  | { t: 'endOfMonth' }
  | { t: 'past' };

interface Found {
  day?: Day;
  clock?: Clock;
  part?: Part;
  relMs?: number;
  /** Abbreviated weekday or bare "15/11": only with a time of day. */
  needsTime?: boolean;
  /** Bare "morning", "evening": only with a day or a clock time. */
  needsAnchor?: boolean;
}

interface Atom extends Found {
  start: number;
  end: number;
}

// ---- normalisation (1:1, so indices stay valid) -------------------------

const CHAR_MAP: Record<string, string> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ة: 'ه',
  ى: 'ي',
  ی: 'ي',
  ک: 'ك',
  '’': "'",
  '‘': "'",
  '٪': '%',
  '٫': '.',
  '٬': ',',
};

function normalise(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x660 && code <= 0x669) out += String(code - 0x660);
    else if (code >= 0x6f0 && code <= 0x6f9) out += String(code - 0x6f0);
    else {
      const ch = text[i];
      const mapped = CHAR_MAP[ch];
      if (mapped) out += mapped;
      else {
        const lower = ch.toLowerCase();
        out += lower.length === 1 ? lower : ch;
      }
    }
  }
  return out;
}

// ---- patterns -----------------------------------------------------------

const S = String.raw;
/** Word start / end for Latin and Arabic alike (\b is ASCII-only). */
const L0 = S`(?<![\p{L}\p{N}])`;
const R0 = S`(?![\p{L}\p{N}])`;
/** Arabic word start, allowing a joined و / ف / ب ("وبكرة"). */
const A0 = S`(?<=(?:^|[^\p{L}\p{N}])[وفب]?)`;
/** Number start: not inside a word, a number, a money amount. */
const N0 = S`(?<![\p{L}\p{N}.,:/$€£])`;
const DIA = S`[ً-ْ]*`;

const rx = (source: string) => new RegExp(source, 'gu');
const alt = (words: readonly string[]) =>
  [...words].sort((a, b) => b.length - a.length).join('|');

const EN_WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const EN_ABBR: Record<string, number> = {
  mon: 1,
  tue: 2,
  tues: 2,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
};
const AR_WEEKDAYS: Record<string, number> = {
  الاحد: 0,
  الاثنين: 1,
  الاتنين: 1,
  الثلاثاء: 2,
  الثلاثا: 2,
  الاربعاء: 3,
  الاربعا: 3,
  الخميس: 4,
  الجمعه: 5,
  السبت: 6,
};
const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const EN_TOMORROW = 'tomorrow|tomorow|tmrw|tmr';
const EN_WD = alt(EN_WEEKDAYS);
const EN_COUNT = S`\d{1,3}|a\s+couple\s+of|couple\s+of|a\s+few|few|${alt(Object.keys(NUM_WORDS))}`;
const EN_UNIT = S`minutes?|mins?|hours?|hrs?|days?|weeks?|months?`;
const MONTH_RE = alt(Object.keys(MONTHS));
const AR_TOMORROW = S`بكره|بكرا|غد${DIA}ا${DIA}|باچر|باكر`;
const AR_WD = alt(Object.keys(AR_WEEKDAYS));
const AR_NUM_UNIT = S`ساعات|ساعه|دقايق|دقائق|دقيقه|ايام|يوم|اسابيع|اسبوع|شهور|اشهر|شهر`;
const AR_WORD_UNIT = S`ساعه\s*و\s*نص|ساعتين|ساعه|يومين|يوم|اسبوعين|اسبوع|شهرين|شهر|دقيقتين|دقيقه|(?:نصف|نص|ربع)\s+ساعه`;
const AR_NEXT = S`الجايه|الجاي|القادمه|القادم`;
const AR_PAST = S`الماضيه|الماضي|اللي\s+فات|الفايت`;

/** A bare number counts as a clock time when a part of day follows it. */
const PART_AFTER = new RegExp(
  S`^\s*(?:in\s+the\s+(?:morning|afternoon|evening)|at\s+night|noon|midday|tonight|بعد\s+الظهر|ب?ال(?:صبح|صباح|ظهر|عصر|مغرب|مساء|مسا|ليل)|صباح|مساء)`,
  'u'
);
/** What may not follow a clock time: more digits, a decimal, a percent. */
const NUMBER_AFTER = /^(?:\p{N}|[.,:/-]\p{N}|\s*%)/u;

const offset = (days: number): Found => ({ day: { t: 'offset', days } });
const past: Found = { day: { t: 'past' } };

function countOf(raw: string): number {
  const s = raw.replace(/\s+/g, ' ');
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes('couple')) return 2;
  if (s.includes('few')) return 3;
  return NUM_WORDS[s] ?? NaN;
}

/** "in 3 days", "بعد ساعتين": minutes and hours keep the clock. */
function relative(n: number, unit: 'min' | 'h' | 'd' | 'w' | 'mo'): Found {
  if (!Number.isFinite(n)) return {};
  switch (unit) {
    case 'min':
      return { relMs: n * MINUTE };
    case 'h':
      return { relMs: n * HOUR };
    case 'd':
      return offset(n);
    case 'w':
      return offset(7 * n);
    case 'mo':
      return { day: { t: 'months', n } };
  }
}

function enUnit(u: string): 'min' | 'h' | 'd' | 'w' | 'mo' {
  if (u.startsWith('mo')) return 'mo';
  if (u.startsWith('mi')) return 'min';
  if (u.startsWith('h')) return 'h';
  if (u.startsWith('d')) return 'd';
  return 'w';
}

function arUnit(u: string): 'min' | 'h' | 'd' | 'w' | 'mo' {
  if (u.startsWith('ساع')) return 'h';
  if (u.startsWith('دق')) return 'min';
  if (u.includes('يوم') || u === 'ايام') return 'd';
  if (u.includes('سب')) return 'w';
  return 'mo';
}

const AR_WORD_REL: Record<string, Found> = {
  ساعهونص: { relMs: 90 * MINUTE },
  ساعتين: { relMs: 2 * HOUR },
  ساعه: { relMs: HOUR },
  يومين: offset(2),
  يوم: offset(1),
  اسبوعين: offset(14),
  اسبوع: offset(7),
  شهرين: { day: { t: 'months', n: 2 } },
  شهر: { day: { t: 'months', n: 1 } },
  دقيقتين: { relMs: 2 * MINUTE },
  دقيقه: { relMs: MINUTE },
  نصساعه: { relMs: 30 * MINUTE },
  نصفساعه: { relMs: 30 * MINUTE },
  ربعساعه: { relMs: 15 * MINUTE },
};

const AR_PARTS: Record<string, Part> = {
  بعدالظهر: 'afternoon',
  الصبح: 'morning',
  الصباح: 'morning',
  صباحا: 'morning',
  الظهر: 'noon',
  العصر: 'asr',
  المغرب: 'maghrib',
  المساء: 'evening',
  المسا: 'evening',
  مساء: 'evening',
  بالليل: 'night',
  الليل: 'night',
};

const squash = (s: string) => s.replace(/[\sً-ْ]/g, '');

function clockFound(
  hs: string,
  min: number,
  ampm: 'am' | 'pm' | null,
  quarterTo = false
): Found | null {
  const h = Number(hs);
  if (min > 59) return null;
  if (ampm ? h < 1 || h > 12 : h > 23) return null;
  const literal = (hs.length === 2 && hs[0] === '0') || h === 0 || h > 12;
  return { clock: { h, min, ampm, literal, quarterTo } };
}

type Make = (m: RegExpExecArray, norm: string) => Found | null;

const MATCHERS: { re: RegExp; make: Make }[] = [
  // ---- English days
  {
    re: rx(S`${L0}(?:the\s+)?day\s+after\s+(?:${EN_TOMORROW})${R0}`),
    make: () => offset(2),
  },
  { re: rx(S`${L0}(?:${EN_TOMORROW})${R0}`), make: () => offset(1) },
  { re: rx(S`${L0}today${R0}`), make: () => offset(0) },
  {
    re: rx(S`${L0}tonight${R0}`),
    make: () => ({ ...offset(0), part: 'night' }),
  },
  {
    re: rx(S`${L0}(?:(?:on|this|next|coming)\s+){0,2}(${EN_WD})${R0}`),
    make: (m) => ({ day: { t: 'weekday', wd: EN_WEEKDAYS.indexOf(m[1]) } }),
  },
  {
    re: rx(
      S`${L0}(?:(?:on|this|next|coming)\s+){0,2}(${alt(Object.keys(EN_ABBR))})\.?${R0}`
    ),
    make: (m) => ({
      day: { t: 'weekday', wd: EN_ABBR[m[1]] },
      needsTime: true,
    }),
  },
  { re: rx(S`${L0}next\s+week${R0}`), make: () => offset(7) },
  {
    re: rx(S`${L0}next\s+month${R0}`),
    make: () => ({ day: { t: 'months', n: 1 } }),
  },
  {
    re: rx(S`${L0}(?:the\s+)?end\s+of\s+(?:the\s+)?month${R0}`),
    make: () => ({ day: { t: 'endOfMonth' } }),
  },
  // ---- English relative
  {
    re: rx(S`${L0}(?:in|after)\s+(${EN_COUNT})\s*(${EN_UNIT})${R0}`),
    make: (m) => relative(countOf(m[1]), enUnit(m[2])),
  },
  {
    re: rx(
      S`${L0}(?:in|after)\s+(?:(half\s+an?\s+hour)|an?\s+hour\s+and\s+a\s+half)${R0}`
    ),
    make: (m) => ({ relMs: (m[1] ? 30 : 90) * MINUTE }),
  },
  // ---- English past markers
  { re: rx(S`${L0}(?:yesterday|earlier\s+today)${R0}`), make: () => past },
  {
    re: rx(S`${L0}last\s+(?:week|month|year|night|weekend|${EN_WD})${R0}`),
    make: () => past,
  },
  {
    re: rx(S`${L0}(?:${EN_COUNT})\s*(?:${EN_UNIT}|years?)\s+ago${R0}`),
    make: () => past,
  },
  // ---- English dates
  {
    re: rx(
      S`${N0}(?:(on)\s+)?(\d{1,2})([/.\-])(\d{1,2})(?:\3(\d{4}|\d{2}))?(?!\p{N}|[/.\-]\p{N})`
    ),
    make: (m) => {
      const d = Number(m[2]);
      const mo = Number(m[4]) - 1;
      if (d < 1 || d > 31 || mo < 0 || mo > 11) return null;
      const y = m[5] ? Number(m[5]) + (m[5].length === 2 ? 2000 : 0) : null;
      return { day: { t: 'date', d, m: mo, y }, needsTime: !m[1] && !y };
    },
  },
  {
    re: rx(
      S`${N0}(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_RE})\.?(?:,?\s+(\d{4}))?${R0}`
    ),
    make: (m) => textDate(m[1], m[2], m[3]),
  },
  {
    re: rx(
      S`${L0}(?:on\s+)?(${MONTH_RE})\.?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\p{L}\p{N}]|[:.]\p{N})`
    ),
    make: (m) => textDate(m[2], m[1], m[3]),
  },
  {
    re: rx(S`${L0}(?:on|by)\s+the\s+(\d{1,2})(?:st|nd|rd|th)${R0}`),
    make: (m) => {
      const d = Number(m[1]);
      return d >= 1 && d <= 31 ? { day: { t: 'dom', d } } : null;
    },
  },
  // ---- English times
  {
    re: rx(
      S`${N0}(?:(at|@|around|by)\s*)?(\d{1,2})(?:([:.])(\d{2}))?(?:\s*(o'?clock))?(?:\s*([ap])\.?\s?m\.?${R0})?`
    ),
    make: (m, norm) => {
      const [whole, prefix, hs, sep, ms, oclock, ap] = m;
      const after = norm.slice(m.index + whole.length);
      if (NUMBER_AFTER.test(after)) return null;
      const bare = !prefix && !sep && !oclock && !ap;
      if (bare && !PART_AFTER.test(after)) return null;
      if (sep === '.' && !prefix && !ap) return null;
      return clockFound(
        hs,
        ms ? Number(ms) : 0,
        ap ? (ap === 'a' ? 'am' : 'pm') : null
      );
    },
  },
  {
    re: rx(
      S`${L0}(?:(?:at|by)\s+)?(noon|midday|eod|end\s+of\s+(?:the\s+)?day)${R0}`
    ),
    make: (m) => ({ part: m[1].startsWith('e') ? 'eod' : 'noon' }),
  },
  {
    re: rx(
      S`${L0}(?:(this|in\s+the|at|by\s+the)\s+)?(morning|afternoon|evening|night)${R0}`
    ),
    make: (m) => ({
      ...(m[1] === 'this' ? offset(0) : {}),
      part: m[2] as Part,
      needsAnchor: !m[1],
    }),
  },
  // ---- Arabic days
  {
    re: rx(S`${A0}بعد\s+(?:${AR_TOMORROW}|غد${DIA})${R0}`),
    make: () => offset(2),
  },
  { re: rx(S`${A0}(?:${AR_TOMORROW})${R0}`), make: () => offset(1) },
  { re: rx(S`${A0}اليوم${R0}`), make: () => offset(0) },
  {
    re: rx(S`${A0}الليله${R0}`),
    make: () => ({ ...offset(0), part: 'night' }),
  },
  {
    re: rx(S`${A0}(?:يوم\s+)?(${AR_WD})(?:\s+(?:${AR_NEXT}))?${R0}`),
    make: (m) => ({ day: { t: 'weekday', wd: AR_WEEKDAYS[m[1]] } }),
  },
  {
    re: rx(S`${A0}(?:يوم\s+)?(?:${AR_WD})\s+(?:${AR_PAST})${R0}`),
    make: () => past,
  },
  {
    re: rx(S`${A0}الاسبوع\s+(?:${AR_NEXT})${R0}`),
    make: () => offset(7),
  },
  {
    re: rx(S`${A0}الشهر\s+(?:${AR_NEXT})${R0}`),
    make: () => ({ day: { t: 'months', n: 1 } }),
  },
  {
    re: rx(S`${A0}(?:اخر|نهايه)\s+الشهر${R0}`),
    make: () => ({ day: { t: 'endOfMonth' } }),
  },
  {
    re: rx(
      S`${A0}بعد\s+(?:(\d{1,3})\s*(${AR_NUM_UNIT})|(${AR_WORD_UNIT}))${R0}`
    ),
    make: (m) =>
      m[1] ? relative(Number(m[1]), arUnit(m[2])) : AR_WORD_REL[squash(m[3])],
  },
  // ---- Arabic past markers
  { re: rx(S`${A0}(?:امس|البارحه)${R0}`), make: () => past },
  {
    re: rx(S`${A0}(?:الاسبوع|الشهر|السنه)\s+(?:${AR_PAST})${R0}`),
    make: () => past,
  },
  {
    re: rx(S`${A0}قبل\s+(?:\d{1,3}\s*(?:${AR_NUM_UNIT})|${AR_WORD_UNIT})${R0}`),
    make: () => past,
  },
  // ---- Arabic times
  {
    re: rx(
      S`${A0}الساعه\s*(\d{1,2})(?:([:.])(\d{2}))?(?:\s*(?:(و\s*(?:نصف|نص|ربع))|(الا\s*ربع))${R0})?(?!\p{N})`
    ),
    make: (m, norm) => {
      if (NUMBER_AFTER.test(norm.slice(m.index + m[0].length))) return null;
      return arabicClock(m[1], m[3], m[4], m[5]);
    },
  },
  {
    re: rx(S`${N0}(\d{1,2})\s*(?:(و\s*(?:نصف|نص|ربع))|(الا\s*ربع))${R0}`),
    make: (m) => arabicClock(m[1], undefined, m[2], m[3]),
  },
  {
    re: rx(
      S`${A0}(بعد\s+الظهر|الصبح|الصباح|صباح${DIA}ا|الظهر|العصر|المغرب|المساء|المسا|مساء|بالليل|الليل)${DIA}${R0}`
    ),
    make: (m) => {
      const part = AR_PARTS[squash(m[1])];
      return part ? { part } : null;
    },
  },
];

function textDate(ds: string, month: string, ys: string | undefined): Found {
  return {
    day: {
      t: 'date',
      d: Number(ds),
      m: MONTHS[month],
      y: ys ? Number(ys) : null,
    },
  };
}

function arabicClock(
  hs: string,
  ms: string | undefined,
  half: string | undefined,
  quarterTo: string | undefined
): Found | null {
  let min = ms ? Number(ms) : 0;
  if (!ms && half) min = half.includes('ربع') ? 15 : 30;
  return clockFound(hs, min, null, !!quarterTo);
}

/** Spans no candidate may touch: money, percentages, phones, greetings. */
const BLOCKS: RegExp[] = [
  rx(
    S`${L0}(?:aed|dhs?|dirhams?|usd|sar|qar|kwd|bhd|omr|eur|gbp|inr|rs\.?|درهم|دراهم)\s*\d[\d,.]*`
  ),
  rx(S`[$€£]\s*\d[\d,.]*`),
  rx(
    S`(?<![\p{N}.,])\d[\d,.]*\s*(?:aed|dhs?|dirhams?|usd|sar|qar|eur|gbp|k|mn|million|thousand|درهم|دراهم|ريال|الف|الاف|مليون)${R0}`
  ),
  rx(S`(?<![\p{N}.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?`),
  rx(S`\d+(?:[.,]\d+)?\s*%`),
  rx(S`${L0}24\s*/\s*7${R0}`),
  rx(S`${L0}(?:v|version\s*)\d+(?:\.\d+)+`),
  rx(S`${L0}good\s*(?:morning|afternoon|evening|night)${R0}`),
  rx(S`${A0}(?:صباح|مساء|مسا)${DIA}\s+(?:الخير|النور|الورد|الفل)`),
];
/** Seven or more digits, optionally spaced or dashed: a phone number. */
const PHONE = rx(S`(?<!\p{N})\+?\d(?:[\s\-]?\d){6,}`);
const DATE_SHAPE = /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;

function scan(norm: string): Atom[] {
  const blocks: [number, number][] = [];
  for (const re of BLOCKS) {
    re.lastIndex = 0;
    for (const m of norm.matchAll(re))
      blocks.push([m.index, m.index + m[0].length]);
  }
  PHONE.lastIndex = 0;
  for (const m of norm.matchAll(PHONE)) {
    if (!DATE_SHAPE.test(m[0])) blocks.push([m.index, m.index + m[0].length]);
  }

  const atoms: Atom[] = [];
  for (const { re, make } of MATCHERS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm))) {
      const found = make(m, norm);
      if (!found || Object.keys(found).length === 0) {
        re.lastIndex = m.index + 1;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (blocks.some(([s, e]) => start < e && s < end)) continue;
      atoms.push({ ...found, start, end });
    }
  }
  // Earliest first, longest first; then drop anything overlapping a kept one.
  atoms.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Atom[] = [];
  let reach = 0;
  for (const a of atoms) {
    if (a.start < reach) continue;
    kept.push(a);
    reach = a.end;
  }
  return kept;
}

// ---- combining ----------------------------------------------------------

const FILLER = /^(?:[\s,،\-@]|at|around|by|on|الساعه|علي)*$/u; // "على" after ى → ي

interface Group extends Found {
  start: number;
  end: number;
}

function mergeAtoms(atoms: Atom[], norm: string): Group[] {
  const groups: Group[] = [];
  for (const a of atoms) {
    const g = groups[groups.length - 1];
    const gap = g ? norm.slice(g.end, a.start) : '';
    const joins =
      g &&
      g.relMs === undefined &&
      a.relMs === undefined &&
      gap.length <= MAX_GAP &&
      FILLER.test(gap) &&
      !(a.day && g.day) &&
      !(a.clock && g.clock) &&
      !(a.part && g.part);
    if (!joins) {
      groups.push({ ...a });
      continue;
    }
    g.end = a.end;
    g.day ??= a.day;
    g.clock ??= a.clock;
    g.part ??= a.part;
    g.needsTime = g.needsTime || a.needsTime;
    g.needsAnchor = g.needsAnchor || a.needsAnchor;
  }
  return groups;
}

// ---- resolving ----------------------------------------------------------

interface Ymd {
  y: number;
  /** 0-based. */
  m: number;
  d: number;
}

function ymdOf(utcMs: number): Ymd {
  const t = new Date(utcMs);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

const addDays = (a: Ymd, n: number): Ymd => ymdOf(Date.UTC(a.y, a.m, a.d + n));
const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const weekdayOf = (a: Ymd): number =>
  new Date(Date.UTC(a.y, a.m, a.d)).getUTCDay();

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds `zone` is ahead of UTC at the instant `ms`. */
function zoneOffset(ms: number, zone: string): number {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  const get = (type: string, parts: Intl.DateTimeFormatPart[]) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const parts = f.formatToParts(new Date(ms));
  const asUtc = Date.UTC(
    get('year', parts),
    get('month', parts) - 1,
    get('day', parts),
    get('hour', parts) % 24,
    get('minute', parts),
    get('second', parts)
  );
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The zone's calendar date at `ms`. */
function localDate(ms: number, zone: string): Ymd {
  return ymdOf(ms + zoneOffset(ms, zone));
}

/** The instant a wall-clock time in `zone` names. Two passes, so the
 *  offset is the one in force at the answer, not at the guess (DST). */
function wallToInstant(a: Ymd, minutes: number, zone: string): number {
  const asUtc = Date.UTC(a.y, a.m, a.d, 0, minutes);
  const guess = asUtc - zoneOffset(asUtc, zone);
  return asUtc - zoneOffset(guess, zone);
}

/** The minute of the day a clock time means, am/pm settled. */
function clockMinutes(c: Clock, part: Part | undefined): number {
  let h = c.h;
  if (c.ampm) h = (h % 12) + (c.ampm === 'pm' ? 12 : 0);
  else if (!c.literal) {
    if (part === 'morning') h = h === 12 ? 0 : h;
    else if (part) h = h === 12 ? 12 : h + 12;
    else if (h <= 7) h += 12; // bare 1-7: afternoon; 8-11 morning; 12 noon
  }
  const total = h * 60 + c.min - (c.quarterTo ? 15 : 0);
  return ((total % 1440) + 1440) % 1440;
}

function resolveGroup(
  g: Group,
  nowMs: number,
  today: Ymd,
  zone: string
): { ms: number; dateOnly: boolean } | null {
  if (g.relMs !== undefined) return { ms: nowMs + g.relMs, dateOnly: false };
  const tod = g.clock
    ? clockMinutes(g.clock, g.part)
    : g.part
      ? PART_HOUR[g.part] * 60
      : null;
  const dateOnly = tod === null;
  const at = (a: Ymd) => wallToInstant(a, tod ?? DATE_ONLY_HOUR * 60, zone);
  const done = (a: Ymd | null) => (a ? { ms: at(a), dateOnly } : null);
  const day = g.day;

  if (!day) {
    // A time with no day: today if still ahead, else tomorrow.
    if (dateOnly) return null;
    return done(at(today) > nowMs ? today : addDays(today, 1));
  }
  switch (day.t) {
    case 'offset':
      return done(addDays(today, day.days));
    case 'weekday': {
      let delta = (day.wd - weekdayOf(today) + 7) % 7;
      if (delta === 0 && (dateOnly || at(today) <= nowMs)) delta = 7;
      return done(addDays(today, delta));
    }
    case 'date': {
      let y = day.y ?? today.y;
      if (
        day.y === null &&
        (day.m < today.m || (day.m === today.m && day.d < today.d))
      )
        y += 1;
      if (day.d > daysInMonth(y, day.m)) return null;
      return done({ y, m: day.m, d: day.d });
    }
    case 'dom':
      for (let k = 0; k <= 12; k++) {
        const first = ymdOf(Date.UTC(today.y, today.m + k, 1));
        if (day.d > daysInMonth(first.y, first.m)) continue;
        if (k === 0 && day.d < today.d) continue;
        const a = { ...first, d: day.d };
        if (at(a) > nowMs) return done(a);
      }
      return null;
    case 'months': {
      const first = ymdOf(Date.UTC(today.y, today.m + day.n, 1));
      const d = Math.min(today.d, daysInMonth(first.y, first.m));
      return done({ ...first, d });
    }
    case 'endOfMonth':
      return done({ ...today, d: daysInMonth(today.y, today.m) });
    case 'past':
      return null;
  }
}
