// ============================================================
// Safe CSV building for every report export (Track F).
//
// Two rules, both here so no route can forget them:
//   1. Every field is quoted, with embedded quotes doubled (RFC 4180),
//      so a comma, quote or newline in a name never shifts a column.
//   2. A cell a spreadsheet would read as a formula is neutralised: a
//      value starting with =, +, -, @, a tab or a carriage return gets a
//      leading apostrophe (OWASP "CSV injection"). Numbers are written
//      as numbers, so a negative figure is never touched.
// Pure: no I/O.
// ============================================================

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted and neutralised. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `"${String(value)}"` : '""';
  }
  if (typeof value === 'boolean') return value ? '"true"' : '"false"';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
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

/** A safe download file name: letters, digits, dot, dash, underscore. */
export function csvFileName(stem: string, date: Date = new Date()): string {
  const clean = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const day = date.toISOString().slice(0, 10);
  return `${clean || 'export'}-${day}.csv`;
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
