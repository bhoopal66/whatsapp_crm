// ============================================================
// Safe CSV building for every report export (Track F).
//
// Two rules, both here so no route can forget them:
//   1. Every field is quoted, with embedded quotes doubled (RFC 4180),
//      so a comma, quote or newline in a name never shifts a column.
//   2. A cell a spreadsheet would read as a formula is neutralised
//      (`neutraliseFormula`, which every hand-built CSV uses too).
//      Numbers are written as numbers, so a negative figure is never
//      touched.
// Pure: no I/O.
// ============================================================

import { dubaiDay } from '@/lib/case-files/day';

export type CsvCell = string | number | boolean | null | undefined;

/** The zone of every time in an export. */
export const CSV_TIME_ZONE = 'Asia/Dubai';

// The full-width forms are read as their ASCII ones by a spreadsheet in
// an East Asian locale.
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
const FORMULA_AFTER_BREAK = /([;\t\n])(?=[=+\-@＝＋－＠])/g;

/**
 * Text a spreadsheet will not run (OWASP "CSV injection"): one starting
 * with =, +, -, @, a tab or a line break gets a leading apostrophe. So
 * does such a sign after a semicolon, tab or newline inside the cell,
 * since a program that splits there makes it the start of its own cell.
 */
export function neutraliseFormula(text: string): string {
  const inner = text.replace(FORMULA_AFTER_BREAK, "$1'");
  return FORMULA_START.test(text) ? `'${inner}` : inner;
}

/** One cell, quoted and neutralised. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `"${String(value)}"` : '""';
  }
  if (typeof value === 'boolean') return value ? '"true"' : '"false"';
  const text = neutraliseFormula(String(value));
  return `"${text.replace(/"/g, '""')}"`;
}

/** Header plus rows, CRLF line ends, with a UTF-8 BOM for Excel. */
export function buildCsv(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[]
): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * A stored time as `2026-11-23 09:30:05` in CSV_TIME_ZONE (name the zone
 * in the heading), which a spreadsheet reads as a time. Empty when there
 * is none.
 */
export function csvTime(at: string | null | undefined): string {
  const time = at ? new Date(at) : null;
  if (!time || Number.isNaN(time.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: CSV_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(time);
}

/**
 * A safe download file name (letters, digits, dot, dash, underscore) with
 * Dubai's day: in UTC a file saved before 04:00 carried yesterday's.
 */
export function csvFileName(stem: string, date: Date = new Date()): string {
  const clean = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${clean || 'export'}-${dubaiDay(date)}.csv`;
}

/** The Response for a CSV download: never cached, always an attachment. */
export function csvResponse(body: string, fileName: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
