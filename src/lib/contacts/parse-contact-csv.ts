import { parseCsvRecords } from './csv-records';

/**
 * CSV parsing for the contacts import modal and the broadcast wizard,
 * and the header/row logic the wizard also runs over Excel sheets.
 * Contact tags are retired, so a `tags` column is not read: it rides
 * along in `values` like any other column the importer has no use for.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /**
   * Every cell of the row keyed by its (lower-cased) header, known
   * columns included. Broadcast personalization maps template
   * variables to arbitrary CSV columns through this, so a column the
   * importer has no use for (`order_id`, `due_date`, …) still rides
   * along.
   */
  values: Record<string, string>;
  /** The file line the row starts on, when it was read from a CSV. */
  line?: number;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the header includes a `company` (or `company name`) column. */
  hasCompanyColumn: boolean;
  /**
   * Header names in file order, lower-cased, trimmed and with inner
   * whitespace collapsed; blanks dropped.
   */
  columns: string[];
}

export interface ParseContactTableResult extends ParseContactCsvResult {
  /** The header the phone numbers were read from; null when none fit. */
  phoneColumn: string | null;
  /**
   * Data rows left out for an empty phone cell. Fully blank rows are
   * not counted: they are spacing, not contacts without a number.
   */
  skippedNoPhone: number;
  /** Their file lines, when the table came with its lines. */
  noPhoneLines?: number[];
}

export interface ReadContactCsvResult extends ParseContactTableResult {
  noPhoneLines: number[];
  /** Lines that could not be read (a quote that never closes). */
  badLines: number[];
}

/**
 * Header names accepted when the exact one is absent, in order of
 * preference. Spreadsheets exported from other systems say "Phone
 * Number" or "Customer Name", and asking people to rename a column
 * before every upload only gets the file sent somewhere else.
 */
const HEADER_ALIASES = {
  phone: [
    'phone number',
    'mobile',
    'mobile number',
    'whatsapp',
    'whatsapp number',
  ],
  name: ['customer name', 'full name', 'contact name'],
  email: ['email address'],
  company: ['company name'],
} as const;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

function headerIndex(
  headers: string[],
  key: keyof typeof HEADER_ALIASES
): number {
  for (const candidate of [key, ...HEADER_ALIASES[key]]) {
    const idx = headers.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** The column the phone numbers are read from; -1 when none fits. */
export function contactPhoneColumn(header: string[]): number {
  return headerIndex(header.map(normalizeHeader), 'phone');
}

/**
 * Contact rows from a table of cells, row 0 being the header — a CSV
 * split into cells, or an Excel sheet (`read-xlsx.ts`). Cells are
 * taken as they are apart from trimming; a line break inside a name,
 * email or company becomes a space. `lines` gives each table row's
 * file line, for reporting.
 */
export function parseContactTable(
  table: string[][],
  lines?: readonly number[]
): ParseContactTableResult {
  const headers = (table[0] ?? []).map(normalizeHeader);
  const phoneIdx = headerIndex(headers, 'phone');
  if (phoneIdx === -1) {
    return {
      rows: [],
      hasCompanyColumn: false,
      columns: [],
      phoneColumn: null,
      skippedNoPhone: 0,
    };
  }

  const nameIdx = headerIndex(headers, 'name');
  const emailIdx = headerIndex(headers, 'email');
  const companyIdx = headerIndex(headers, 'company');
  const cellAt = (cells: string[], idx: number) =>
    idx >= 0
      ? cells[idx]?.trim().replace(/\s*[\r\n]+\s*/g, ' ') || undefined
      : undefined;

  const rows: ParsedContactRow[] = [];
  const noPhoneLines: number[] = [];
  let skippedNoPhone = 0;

  for (const [index, cells] of table.slice(1).entries()) {
    const line = lines?.[index + 1];
    if (cells.every((cell) => !cell?.trim())) continue;

    const phone = cells[phoneIdx]?.trim();
    if (!phone) {
      skippedNoPhone++;
      if (line !== undefined) noPhoneLines.push(line);
      continue;
    }

    const byHeader: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      byHeader[header] = cells[idx]?.trim() ?? '';
    });

    rows.push({
      phone,
      name: cellAt(cells, nameIdx),
      email: cellAt(cells, emailIdx),
      company: cellAt(cells, companyIdx),
      values: byHeader,
      ...(line === undefined ? {} : { line }),
    });
  }

  return {
    rows,
    hasCompanyColumn: companyIdx >= 0,
    columns: headers.filter(Boolean),
    phoneColumn: headers[phoneIdx],
    skippedNoPhone,
    ...(lines ? { noPhoneLines } : {}),
  };
}

const stripQuotes = (cell: string) => cell.replace(/["']/g, '');

/**
 * A contacts CSV as a table with each row's file line. Quotes are still
 * stripped from the header and from the phone column (Excel writes a
 * text number as `'+971...`); everywhere else they are part of the value.
 */
function contactCsv(text: string) {
  const { records, badLines } = parseCsvRecords(text);
  const header = (records[0]?.cells ?? ['']).map(stripQuotes);
  const phoneIdx = headerIndex(header.map(normalizeHeader), 'phone');
  const body = records
    .slice(1)
    .map(({ cells }) =>
      cells.map((cell, idx) => (idx === phoneIdx ? stripQuotes(cell) : cell))
    );
  return {
    table: [header, ...body],
    lines: records.map((r) => r.line),
    badLines,
  };
}

/** A contacts CSV as a table for `parseContactTable`. */
export function contactCsvTable(text: string): string[][] {
  return contactCsv(text).table;
}

/** The contacts of a CSV, with the lines that gave no contact. */
export function readContactCsv(text: string): ReadContactCsvResult {
  const { table, lines, badLines } = contactCsv(text);
  const parsed = parseContactTable(table, lines);
  return { ...parsed, noPhoneLines: parsed.noPhoneLines ?? [], badLines };
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const table = contactCsvTable(text);
  if (table.length < 2) {
    return {
      rows: [],
      hasCompanyColumn: false,
      columns: [],
    };
  }
  const { rows, hasCompanyColumn, columns } = parseContactTable(table);
  return { rows, hasCompanyColumn, columns };
}
