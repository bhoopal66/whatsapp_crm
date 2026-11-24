import { describe, expect, it } from 'vitest';
import {
  builtinFormat,
  formatNumber,
  parseFormat,
  plainNumber,
} from './xlsx-number-format';

describe('parseFormat', () => {
  it.each([
    ['dd/mm/yyyy', 'date'],
    ['d-mmm-yy', 'date'],
    ['mmmm', 'date'],
    ['[$-409]dddd, mmmm d, yyyy', 'date'],
    ['[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy;@', 'date'],
    ['yyyy"年"m"月"d"日"', 'date'],
    ['dd/mm/yyyy hh:mm', 'datetime'],
    ['m/d/yy h:mm AM/PM', 'datetime'],
    ['yyyy-mm-dd"T"hh:mm:ss.000', 'datetime'],
    ['h:mm A/P', 'time'],
    ['[Red]HH:MM:SS', 'time'],
    ['[hh]:mm', 'duration'],
  ])('%s is a %s', (code, kind) => {
    expect(parseFormat(code)).toEqual({ kind });
  });

  it.each([
    ['0%', 0, 0],
    ['0.00%', 2, 2],
    ['0.0#%;[Red]-0.0#%', 1, 2],
    ['#,##0.000\\ %', 3, 3],
    ['_-0.0%_-', 1, 1],
  ])('%s is a percentage with its decimals', (code, min, max) => {
    expect(parseFormat(code)).toEqual({ kind: 'percent', min, max });
  });

  it.each([
    'General',
    '@',
    '0.00E+00',
    '# ?/?',
    '#,##0.00',
    '"AED" #,##0.00',
    'AED #,##0',
    '[$AED-1]\\ #,##0.00',
    '[$د.إ.‏-3801]\\ #,##0.00',
    '0.00 "day"',
    '0" days";"dd/mm/yyyy"',
    '00000000000',
    'mm:ss.0',
    '"unclosed dd/mm/yyyy',
    '[unclosed dd/mm/yyyy',
    `${'"x"'.repeat(90)}dd/mm/yyyy`,
    '',
  ])('%s leaves the number alone', (code) => {
    expect(parseFormat(code)).toBeNull();
  });
});

describe('builtinFormat', () => {
  it('knows the built-in dates, times and percentages', () => {
    const kinds = (ids: number[]) => ids.map((id) => builtinFormat(id)?.kind);
    expect(kinds([14, 15, 16, 17, 22, 18, 21, 46, 9, 10, 31])).toEqual([
      ...['date', 'date', 'date', 'date', 'datetime', 'time', 'time'],
      ...['duration', 'percent', 'percent', 'date'],
    ]);
    expect(kinds([0, 1, 2, 3, 4, 11, 12, 37, 44, 48, 49, 164, NaN])).toEqual(
      Array(13).fill(undefined)
    );
  });
});

describe('formatNumber', () => {
  const show = (
    n: number,
    kind: 'date' | 'datetime' | 'time' | 'duration',
    date1904 = false
  ) => formatNumber(n, { kind }, date1904);

  it('writes dates as dd/mm/yyyy', () => {
    expect(show(46371, 'date')).toBe('15/12/2026');
    expect(show(46371.75, 'date')).toBe('15/12/2026');
    expect(show(45351, 'date')).toBe('29/02/2024');
    expect(show(2958465, 'date')).toBe('31/12/9999');
  });

  it("keeps Excel's 1900, 29 February included", () => {
    expect([1, 59, 60, 61].map((n) => show(n, 'date'))).toEqual([
      '01/01/1900',
      '28/02/1900',
      '29/02/1900',
      '01/03/1900',
    ]);
  });

  it('counts from 1904 when the workbook does', () => {
    // The same day, 1,462 lower.
    expect(show(44909, 'date', true)).toBe('15/12/2026');
    expect(show(0, 'date', true)).toBe('01/01/1904');
  });

  it('writes times as hh:mm, to the second before the minute', () => {
    expect(show(46371 + 620 / 1440, 'datetime')).toBe('15/12/2026 10:20');
    expect(show(46371, 'datetime')).toBe('15/12/2026 00:00');
    expect(show(46371.999999999, 'datetime')).toBe('16/12/2026 00:00');
    expect(show(0.430555555555556, 'time')).toBe('10:20');
    expect(show(1.5, 'duration')).toBe('36:00');
  });

  it('has no text for a day outside the calendar', () => {
    expect(show(0, 'date')).toBeNull();
    expect(show(-1, 'date')).toBeNull();
    expect(show(971501234567, 'date')).toBeNull();
    expect(show(1e300, 'time')).toBeNull();
  });

  it('writes percentages with the decimals of the format', () => {
    const percent = (n: number, min: number, max: number) =>
      formatNumber(n, { kind: 'percent', min, max }, false);
    expect(percent(0.0725, 2, 2)).toBe('7.25%');
    expect(percent(0.0725, 1, 1)).toBe('7.3%');
    expect(percent(0.0725, 0, 0)).toBe('7%');
    expect(percent(0.07, 1, 2)).toBe('7.0%');
    expect(percent(0.07, 0, 2)).toBe('7%');
    expect(percent(1, 0, 0)).toBe('100%');
    expect(percent(-0.005, 1, 1)).toBe('-0.5%');
    expect(percent(-0.00001, 0, 0)).toBe('0%');
    expect(percent(1e-9, 2, 2)).toBe('0.00%');
    expect(percent(0.29, 0, 0)).toBe('29%');
  });
});

describe('plainNumber', () => {
  it('drops the binary tail and keeps the rest', () => {
    expect(
      [
        '0.30000000000000004',
        '4350.0999999999995',
        '1.5',
        '9.71501234567E+11',
        '971501234567',
        '7.0',
        '1E+300',
        '1.5E-7',
        '',
        'abc',
      ].map(plainNumber)
    ).toEqual([
      '0.3',
      '4350.1',
      '1.5',
      '971501234567',
      '971501234567',
      '7',
      '1E+300',
      '1.5E-7',
      '',
      'abc',
    ]);
  });
});
