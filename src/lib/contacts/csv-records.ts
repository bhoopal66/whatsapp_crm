// CSV text to records, RFC 4180: quoted fields, doubled quotes,
// separators and line breaks inside quotes, CRLF / LF / CR, BOM.

export interface CsvRecord {
  cells: string[];
  /** The file line the record starts on, counted from 1. */
  line: number;
}

export interface CsvRecords {
  records: CsvRecord[];
  /** Lines that could not be read: a quoted cell that never closes. */
  badLines: number[];
}

/**
 * One record from `start`; `next` is where the following one starts.
 * Null for a stray quote: one that never closes, or that closes on a
 * later line in the middle of text. Taken as a cell, either would have
 * swallowed the rows in between.
 *
 * A quote opens a cell only at its start, so `Al "Best" Trading` keeps
 * its quotes, and text after a closing quote on the same line is kept.
 */
function readRecord(
  text: string,
  start: number,
  separator: string
): { cells: string[]; next: number } | null {
  const cells: string[] = [];
  let cell = '';
  let i = start;
  for (;;) {
    const char = text[i];
    if (char === undefined || char === '\n' || char === '\r') {
      cells.push(cell);
      const crlf = char === '\r' && text[i + 1] === '\n';
      return { cells, next: i + (crlf ? 2 : 1) };
    }
    if (char === separator) {
      cells.push(cell);
      cell = '';
      i++;
    } else if (char === '"' && !cell.trim()) {
      cell = '';
      let multiLine = false;
      for (i++; ; i++) {
        const inner = text[i];
        if (inner === undefined) return null;
        if (inner === '"') {
          if (text[i + 1] !== '"') break;
          i++;
        } else if (inner === '\n' || inner === '\r') {
          multiLine = true;
        }
        cell += inner;
      }
      i++;
      // The rest of the cell, up to the separator or the line's end.
      let rest = '';
      while (i < text.length && !`${separator}\r\n`.includes(text[i]))
        rest += text[i++];
      if (multiLine && rest.trim()) return null;
      cell += rest;
    } else {
      cell += char;
      i++;
    }
  }
}

/** Where the line after the one at `start` begins. */
function nextLine(text: string, start: number): number {
  const found = /\r\n|\r|\n/g;
  found.lastIndex = start;
  const match = found.exec(text);
  return match ? match.index + match[0].length : text.length;
}

/**
 * The separator of a header line: `;` or a tab when the line has one
 * outside quotes and no comma, else the comma.
 */
export function csvSeparator(headerLine: string): string {
  const bare = headerLine.replace(/"[^"]*"/g, '');
  if (bare.includes(',')) return ',';
  if (bare.includes(';')) return ';';
  return bare.includes('\t') ? '\t' : ',';
}

/** Every record of the file, blank lines left out. */
export function parseCsvRecords(input: string): CsvRecords {
  const text = input.replace(/^﻿/, '');
  const headerAt = text.search(/\S/);
  const separator = csvSeparator(
    headerAt < 0 ? '' : text.slice(headerAt, nextLine(text, headerAt))
  );
  const records: CsvRecord[] = [];
  const badLines: number[] = [];
  let line = 1;
  let at = 0;
  while (at < text.length) {
    const record = readRecord(text, at, separator);
    if (!record) badLines.push(line);
    else if (record.cells.some((cell) => cell.trim()))
      records.push({ cells: record.cells.map((c) => c.trim()), line });
    const next = record
      ? Math.min(record.next, text.length)
      : nextLine(text, at);
    line += text.slice(at, next).match(/\r\n|\r|\n/g)?.length ?? 0;
    at = next;
  }
  return { records, badLines };
}
