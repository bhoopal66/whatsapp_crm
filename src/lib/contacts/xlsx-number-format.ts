// What an Excel number cell shows. The file stores 46371 and 0.0725; that
// they are 15/12/2026 and 7.25% is in the cell's number format. Only dates,
// times and percentages are read: every other format leaves the number as
// it is.

export type CellFormat =
  | { kind: 'date' | 'datetime' | 'time' | 'duration' }
  /** Decimals always written, and at most. */
  | { kind: 'percent'; min: number; max: number };

const DATE: CellFormat = { kind: 'date' };
const DATETIME: CellFormat = { kind: 'datetime' };
const TIME: CellFormat = { kind: 'time' };

/**
 * The built-in formats, which a file names by number alone (ECMA-376
 * 18.8.30). 27-36 and 50-58 are the East Asian dates.
 */
export function builtinFormat(id: number): CellFormat | null {
  if (id === 9) return { kind: 'percent', min: 0, max: 0 };
  if (id === 10) return { kind: 'percent', min: 2, max: 2 };
  if (id >= 14 && id <= 17) return DATE;
  if (id >= 18 && id <= 21) return TIME;
  if (id === 22) return DATETIME;
  if (id === 32 || id === 33) return TIME;
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return DATE;
  if (id === 46) return { kind: 'duration' };
  return null;
}

/** Excel's own limit on a format code. */
const MAX_CODE_LENGTH = 255;

/**
 * A custom format code's first section, the one for positive numbers.
 * Null when it is neither a date nor a percentage. A section with a digit
 * placeholder is a number whatever letters it has: some writers leave a
 * currency unquoted ("AED #,##0"), and its D is not a day.
 */
export function parseFormat(code: string): CellFormat | null {
  if (code.length > MAX_CODE_LENGTH) return null;
  // The date letters in order, a run of one letter counted once; "H" is
  // the elapsed "[h]".
  let letters = '';
  let digits = false;
  let percent = false;
  let point = false;
  let afterSeconds = false;
  let min = 0;
  let max = 0;
  let previous = '';
  for (let i = 0; i < code.length && code[i] !== ';'; i++) {
    const char = code[i].toLowerCase();
    const before = previous;
    previous = char;
    if (char === '"') {
      const end = code.indexOf('"', i + 1);
      if (end === -1) break;
      i = end;
    } else if (char === '\\' || char === '_' || char === '*') {
      i++;
    } else if (char === '[') {
      const end = code.indexOf(']', i);
      if (end === -1) break;
      if (/^h+$/i.test(code.slice(i + 1, end))) letters += 'H';
      i = end;
    } else if (/^(?:am\/pm|a\/p)/i.test(code.slice(i, i + 5))) {
      i += code[i + 1] === '/' ? 2 : 4;
    } else if ('dmyhs'.includes(char)) {
      if (char !== before) letters += char;
      afterSeconds = char === 's';
    } else if (char === '.') {
      point = true;
    } else if ('0#?'.includes(char)) {
      // "ss.00" is a fraction of a second.
      if (afterSeconds) continue;
      digits = true;
      if (point) {
        max++;
        if (char === '0') min = max;
      }
    } else {
      afterSeconds = false;
      if (char === '%') percent = true;
    }
  }
  if (digits) return percent ? { kind: 'percent', min, max } : null;
  const hours = /h/i.test(letters);
  // An "m" after hours or before seconds is minutes, else a month.
  const calendar = letters.replace(/(?<=h)m|m(?=s)/gi, '');
  if (/[dmy]/.test(calendar)) return hours ? DATETIME : DATE;
  if (!hours) return null;
  return letters.includes('H') ? { kind: 'duration' } : TIME;
}

const DAY_SECONDS = 86_400;
/** 31/12/9999, the last day Excel has. */
const LAST_SERIAL = 2_958_465;

const two = (n: number) => String(n).padStart(2, '0');

function dateText(days: number, date1904: boolean): string | null {
  if (date1904 ? days < 0 : days < 1) return null;
  // Excel's 1900 has a 29 February.
  if (!date1904 && days === 60) return '29/02/1900';
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const date = new Date(epoch + days * DAY_SECONDS * 1000);
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/** Rounded half away from zero, as Excel shows it, on its 15 digits. */
function percentText(n: number, min: number, max: number): string | null {
  const value = Math.abs(Number((n * 100).toPrecision(15)));
  if (value >= 1e15) return null;
  const places = Math.min(max, 10);
  const shifted = Math.round(Number(`${value}e${places}`));
  let text = Number.isSafeInteger(shifted)
    ? (shifted / 10 ** places).toFixed(places)
    : value.toFixed(places);
  for (let left = places; left > min && text.endsWith('0'); left--)
    text = text.slice(0, -1);
  text = text.replace(/\.$/, '');
  return `${n < 0 && Number(text) !== 0 ? '-' : ''}${text}%`;
}

/**
 * The number as its format shows it, dates as dd/mm/yyyy and times as
 * hh:mm whatever their layout in the sheet. Null for one that has no such
 * text (a day before the calendar starts): the caller writes the number.
 */
export function formatNumber(
  n: number,
  format: CellFormat,
  date1904: boolean
): string | null {
  if (format.kind === 'percent') return percentText(n, format.min, format.max);
  if (!(n >= 0 && n <= LAST_SERIAL)) return null;
  // To the second first: 10:20 is stored as 0.43055555555555.
  const seconds = Math.round(n * DAY_SECONDS);
  const days = Math.floor(seconds / DAY_SECONDS);
  const minutes = Math.floor((seconds - days * DAY_SECONDS) / 60);
  const clock = `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
  switch (format.kind) {
    case 'time':
      return clock;
    case 'duration':
      return `${Math.floor(seconds / 3600)}:${two(minutes % 60)}`;
    case 'date':
      return dateText(days, date1904);
    case 'datetime': {
      const date = dateText(days, date1904);
      return date && `${date} ${clock}`;
    }
    default: {
      const never: never = format;
      return never;
    }
  }
}

/**
 * A number as Excel would write it out, in plain digits. A phone number
 * typed into a number cell is stored as a double and can come back as
 * "9.71501234567E+11"; 0.1+0.2 is stored as 0.30000000000000004, and
 * Excel only ever shows 15 digits of it. Beyond that, as stored.
 */
export function plainNumber(raw: string): string {
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (Number.isSafeInteger(n)) return String(n);
  if (!(Math.abs(n) < Number.MAX_SAFE_INTEGER)) return raw;
  const text = String(Number(n.toPrecision(15)));
  return text.includes('e') ? raw : text;
}
