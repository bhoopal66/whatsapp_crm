import { describe, expect, it } from 'vitest';

import { buildCsv, csvCell, csvFileName, csvTime } from './build';

describe('csvCell', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
  });
  it('neutralises formula starts', () => {
    for (const s of ['=1+1', '+971', '-2', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(s).startsWith(`"'`)).toBe(true);
    }
  });
  it('leaves numbers alone, negatives included', () => {
    expect(csvCell(-3)).toBe('"-3"');
    expect(csvCell(12.5)).toBe('"12.5"');
    expect(csvCell(Number.NaN)).toBe('""');
  });
  it('writes empty for null and undefined', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
  it('keeps newlines inside the quotes', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
});

describe('buildCsv', () => {
  it('adds a BOM and CRLF line ends', () => {
    expect(buildCsv(['A', 'B'], [[1, 'x']])).toBe('﻿"A","B"\r\n"1","x"\r\n');
  });
});

describe('csvFileName', () => {
  it('strips unsafe characters', () => {
    expect(
      csvFileName('funnel report/../x', new Date('2026-11-22T00:00:00Z'))
    ).toBe('funnel-report-..-x-2026-11-22.csv');
  });

  it("carries Dubai's day", () => {
    const name = (at: string) => csvFileName('x', new Date(at));
    expect(name('2026-11-22T19:59:59Z')).toBe('x-2026-11-22.csv');
    expect(name('2026-11-22T20:00:00Z')).toBe('x-2026-11-23.csv');
  });
});

describe('csvTime', () => {
  it('is Dubai time, as a spreadsheet reads it', () => {
    expect(csvTime('2026-11-23T05:30:05.123456+00:00')).toBe(
      '2026-11-23 09:30:05'
    );
    expect(csvTime('2026-11-22T21:00:00Z')).toBe('2026-11-23 01:00:00');
  });

  it('is empty where there is no time', () => {
    expect(csvTime(null)).toBe('');
    expect(csvTime('')).toBe('');
    expect(csvTime('soon')).toBe('');
  });
});
