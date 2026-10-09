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

/**
 * Contact rows from a table of cells, row 0 being the header — a CSV
 * split into cells, or an Excel sheet (`read-xlsx.ts`). Cells are
 * taken as they are apart from trimming: quote stripping belongs to
 * the CSV reading, and in a spreadsheet `O'Brien` is a real name.
 */
export function parseContactTable(table: string[][]): ParseContactTableResult {
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
    idx >= 0 ? cells[idx]?.trim() || undefined : undefined;

  const rows: ParsedContactRow[] = [];
  let skippedNoPhone = 0;

  for (const cells of table.slice(1)) {
    if (cells.every((cell) => !cell?.trim())) continue;

    const phone = cells[phoneIdx]?.trim();
    if (!phone) {
      skippedNoPhone++;
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
    });
  }

  return {
    rows,
    hasCompanyColumn: companyIdx >= 0,
    columns: headers.filter(Boolean),
    phoneColumn: headers[phoneIdx],
    skippedNoPhone,
  };
}

/**
 * A contacts CSV as a table for `parseContactTable`. Quotes are
 * stripped from every cell (and the header is split on bare commas),
 * exactly as this parser always has, so a file that parsed before
 * parses the same.
 */
export function contactCsvTable(text: string): string[][] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.replace(/["']/g, ''));
  const body = lines
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseCsvLine(line).map((v) => v.replace(/["']/g, '')));
  return [header, ...body];
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

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
