import { describe, expect, it } from 'vitest';

import { buildCsv, csvCell, csvFileName } from './build';

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
});
