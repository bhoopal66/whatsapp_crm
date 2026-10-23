/**
 * Reads the first worksheet of an Excel `.xlsx` file into rows of cell
 * strings, row 0 being the header (readXlsxTable), or every visible
 * worksheet with its rows in place (readXlsxSheets). Broadcast audiences arrive as Excel
 * exports more often than as CSV, and re-saving one as CSV in Excel
 * mangles long numbers into "9.71505E+11" — so the file is read as it
 * is, in the browser, with no spreadsheet library: an `.xlsx` is a ZIP
 * of XML parts, and a contact list needs only the cell text.
 *
 * Regex rather than DOMParser because the tests run in node. Dates are
 * Excel serial numbers and are returned as such, not converted.
 *
 * The file is untrusted (an admin's upload on the server, anyone's
 * spreadsheet in the browser), and both of its layers can claim far
 * more than it holds: a few KB of deflate can inflate to gigabytes, and
 * one `<row r="2000000000">` would otherwise be padded out row by row.
 * So every read runs on a budget (XLSX_LIMITS) and throws past it.
 */

/** Excel's own grid: columns A to XFD, rows 1 to 1,048,576. */
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_ROWS = 1_048_576;

export interface XlsxLimits {
  /**
   * Cells a workbook may place, every sheet together. Blank padding
   * counts (a cell at XFD1 is 16,384 of them), and so does each row.
   */
  maxCells: number;
  /** Uncompressed bytes of one ZIP entry, declared or actual. */
  maxEntryBytes: number;
  /** Uncompressed bytes of every entry read, together. */
  maxTotalBytes: number;
  /** Tabs (`<sheet>` elements) a workbook may have, hidden ones included. */
  maxSheets: number;
}

export const XLSX_LIMITS: Readonly<XlsxLimits> = {
  maxCells: 2_000_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxSheets: 50,
};

/** What one workbook read has spent so far. */
interface Budget {
  limits: XlsxLimits;
  cells: number;
  bytes: number;
}

function spendCells(budget: Budget, n: number) {
  budget.cells += n;
  if (budget.cells > budget.limits.maxCells) {
    throw new Error(
      `The workbook has more than ${budget.limits.maxCells} cells`
    );
  }
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * The central directory, keyed by entry name. It is read rather than
 * the local headers because a writer that streams (data descriptor,
 * flag bit 3) leaves the local header's sizes at zero.
 */
function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is 22 bytes plus a comment of up to 65,535.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const names = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    ) {
      throw new Error('Malformed ZIP central directory');
    }
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = names.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (flags & 1) throw new Error(`Encrypted ZIP entry: ${name}`);
    entries.set(name, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Inflates raw deflate, giving up as soon as the output passes `limit`
 * bytes. The output is counted as it streams rather than buffered whole
 * and measured afterwards, which is what lets a bomb through.
 */
async function inflate(
  data: Uint8Array<ArrayBuffer>,
  limit: number
): Promise<Uint8Array> {
  const reader = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      void reader.cancel().catch(() => {});
      throw new Error('ZIP entry inflates past its declared size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function readEntry(
  bytes: Uint8Array,
  name: string,
  entry: ZipEntry,
  budget: Budget
): Promise<string> {
  const { maxEntryBytes, maxTotalBytes } = budget.limits;
  // The declared size is charged before inflating, so reads running
  // side by side cannot each pass the total on their own.
  if (entry.size > maxEntryBytes) {
    throw new Error(
      `ZIP entry ${name} is too large (${entry.size} bytes uncompressed, limit ${maxEntryBytes})`
    );
  }
  budget.bytes += entry.size;
  if (budget.bytes > maxTotalBytes) {
    throw new Error(
      `The workbook is too large uncompressed (limit ${maxTotalBytes} bytes)`
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw new Error('Malformed ZIP local header');
  }
  const start =
    at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error('Truncated ZIP entry');
  const data = bytes.slice(start, end);

  let out: Uint8Array;
  if (entry.method === 0) {
    out = data;
  } else if (entry.method === 8) {
    out = await inflate(data, entry.size);
  } else {
    throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  }
  if (out.length !== entry.size) throw new Error('Corrupt ZIP entry');
  return new TextDecoder().decode(out);
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * XML entities, then Excel's own `_xHHHH_` escapes for characters XML
 * cannot carry (`_x000D_` is a carriage return; `_x005F_` escapes the
 * underscore, so `_x005F_x000D_` is the literal text "_x000D_"). One
 * pass each, so `&amp;lt;` stays "&lt;".
 */
function decodeText(raw: string): string {
  return raw
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] !== '#') return XML_ENTITIES[body] ?? whole;
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

/** An attribute's raw value from a tag's attribute text, or null. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    attrs
  );
  return m ? decodeText(m[1] ?? m[2]) : null;
}

/**
 * The text of a shared string or an inline string: every `<t>` run
 * concatenated (rich text splits one cell across several), without the
 * `<rPh>` phonetic guides Japanese files add above the text.
 */
function richText(xml: string): string {
  const visible = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of visible.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += decodeText(m[1] ?? '');
  }
  return text;
}

function sharedStrings(xml: string): string[] {
  return Array.from(
    xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g),
    (m) => richText(m[1] ?? '')
  );
}

/** "B3" → 1; null when the reference has no column letters. */
function columnIndex(ref: string | null): number | null {
  const letters = ref && /^\$?([A-Z]+)/i.exec(ref)?.[1];
  if (!letters) return null;
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** "B3" → 2 (0-based); null when the reference has no row digits. */
function rowIndex(ref: string | null): number | null {
  const digits = ref && /(\d+)$/.exec(ref)?.[1];
  return digits ? Number(digits) - 1 : null;
}

function cellValue(type: string | null, body: string, shared: string[]) {
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(body);
  const raw = v ? decodeText(v[1] ?? '') : '';
  switch (type) {
    case 's':
      // An empty `<c t="s"/>` is a blank cell, not shared string 0
      // (`Number('')` is 0, which would repeat the first header).
      return raw.trim() === '' ? '' : (shared[Number(raw)] ?? '');
    case 'inlineStr': {
      const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
      return is ? richText(is[1]) : '';
    }
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'e':
      return '';
    case 'str':
      return raw;
    default: {
      // A phone number typed into a number cell is stored as a double
      // and can come back as "9.71501234567E+11"; whole numbers are
      // written out in plain digits so it reads as the number it is.
      const n = raw.trim() === '' ? NaN : Number(raw);
      return Number.isSafeInteger(n) ? String(n) : raw;
    }
  }
}

/**
 * Cells and rows are placed by their references, padding the gaps, so
 * a reference is held to Excel's grid and every slot it opens is
 * charged to the budget before the padding is written.
 */
function sheetRows(xml: string, shared: string[], budget: Budget): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const c of (row[2] ?? '').matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      const ref = attr(c[1], 'r');
      const col = columnIndex(ref) ?? cells.length;
      if (col >= XLSX_MAX_COLUMNS) {
        throw new Error(
          `Cell ${ref ?? `#${col + 1}`} is beyond Excel's last column (XFD)`
        );
      }
      spendCells(budget, Math.max(0, col + 1 - cells.length));
      while (cells.length < col) cells.push('');
      cells[col] = cellValue(attr(c[1], 't'), c[2] ?? '', shared);
    }
    const ref = attr(row[1], 'r');
    const at = rowIndex(ref) ?? rows.length;
    if (at < 0 || at >= XLSX_MAX_ROWS) {
      throw new Error(
        `Row ${ref ?? at + 1} is outside Excel's rows 1 to ${XLSX_MAX_ROWS}`
      );
    }
    spendCells(budget, Math.max(0, at + 1 - rows.length));
    while (rows.length < at) rows.push([]);
    rows[at] = cells;
  }
  return rows;
}

/**
 * A relationship target as a path from the package root: "/xl/…" is
 * already one, anything else is relative to `xl/`.
 */
function resolveTarget(target: string): string {
  const parts = target.startsWith('/') ? [] : ['xl'];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function relationships(xml: string): Relationship[] {
  return Array.from(xml.matchAll(/<Relationship\b([^>]*)>/g), (m) => ({
    id: attr(m[1], 'Id') ?? '',
    type: attr(m[1], 'Type') ?? '',
    target: attr(m[1], 'Target') ?? '',
  }));
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

interface Workbook {
  /** An entry's text, or null when the package has no such entry. */
  read: (name: string) => Promise<string | null>;
  rels: Relationship[];
  /** Every `<sheet>` in tab order, with its relationship when it has one. */
  sheets: { name: string; hidden: boolean; rel: Relationship | undefined }[];
  sharedStringsPath: string;
  budget: Budget;
}

/** Opens the package and reads the workbook part and its relationships. */
async function openWorkbook(
  bytes: Uint8Array,
  limits: Partial<XlsxLimits> | undefined
): Promise<Workbook> {
  const budget: Budget = {
    limits: { ...XLSX_LIMITS, ...limits },
    cells: 0,
    bytes: 0,
  };
  const entries = readCentralDirectory(bytes);
  // Each entry is inflated at most once, however many relationships
  // point at it.
  const cache = new Map<string, Promise<string | null>>();
  const read = (name: string) => {
    let text = cache.get(name);
    if (!text) {
      const entry = entries.get(name);
      text = entry
        ? readEntry(bytes, name, entry, budget)
        : Promise.resolve(null);
      cache.set(name, text);
    }
    return text;
  };

  const [workbook, relsXml] = await Promise.all([
    read('xl/workbook.xml'),
    read('xl/_rels/workbook.xml.rels'),
  ]);
  const rels = relsXml ? relationships(relsXml) : [];
  const sheets: Workbook['sheets'] = [];
  for (const { 1: a } of workbook?.matchAll(/<sheet\b([^>]*)>/g) ?? []) {
    if (sheets.length === budget.limits.maxSheets) {
      throw new Error(
        `The workbook has more than ${budget.limits.maxSheets} sheets`
      );
    }
    sheets.push({
      name: attr(a, 'name') ?? '',
      // A hidden tab is skipped: its rows would be messaged (or
      // imported) without the uploader ever having seen them.
      hidden: /^(?:hidden|veryHidden)$/.test(attr(a, 'state') ?? ''),
      rel: rels.find((r) => r.id === attr(a, 'r:id')),
    });
  }
  const sharedRel = rels.find((r) => r.type.endsWith('/sharedStrings'));
  return {
    read,
    rels,
    sheets,
    sharedStringsPath: sharedRel
      ? resolveTarget(sharedRel.target)
      : 'xl/sharedStrings.xml',
    budget,
  };
}

/** `limits` overrides XLSX_LIMITS (tests lower them). */
export async function readXlsxTable(
  bytes: Uint8Array,
  limits?: Partial<XlsxLimits>
): Promise<string[][]> {
  const { read, rels, sheets, sharedStringsPath, budget } = await openWorkbook(
    bytes,
    limits
  );

  // The first visible worksheet in tab order, which need not be
  // sheet1.xml once sheets have been reordered or deleted. A chartsheet
  // is skipped too: it has no cells.
  const sheetRel = sheets
    .filter((s) => !s.hidden)
    .map((s) => s.rel)
    .find((r) => r?.type.endsWith('/worksheet'));
  // The default path only for a package with no relationships at all;
  // a workbook whose every worksheet is hidden has nothing to send.
  if (!sheetRel && rels.length > 0) {
    throw new Error('The workbook has no visible worksheet');
  }
  const sheetPath = sheetRel
    ? resolveTarget(sheetRel.target)
    : 'xl/worksheets/sheet1.xml';

  const [sheet, sharedXml] = await Promise.all([
    read(sheetPath),
    read(sharedStringsPath),
  ]);
  if (sheet === null) throw new Error('The workbook has no worksheet');
  const rows = sheetRows(
    sheet,
    sharedXml ? sharedStrings(sharedXml) : [],
    budget
  );
  // Rows are placed by reference, so a sheet whose header sits below a
  // blank first row would start with []; CSV drops leading blank lines
  // too, and the header must be row 0.
  const start = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  return start === -1 ? [] : rows.slice(start);
}

/**
 * Every visible worksheet in tab order, by tab name. Unlike
 * readXlsxTable the rows are not trimmed: `rows[i]` is sheet row i + 1,
 * so a caller can name the row a problem is on. A package with no
 * relationships at all yields its default sheet as "Sheet1".
 */
export async function readXlsxSheets(
  bytes: Uint8Array,
  limits?: Partial<XlsxLimits>
): Promise<{ name: string; rows: string[][] }[]> {
  const { read, rels, sheets, sharedStringsPath, budget } = await openWorkbook(
    bytes,
    limits
  );
  const targets =
    rels.length === 0
      ? [
          {
            name: sheets[0]?.name || 'Sheet1',
            path: 'xl/worksheets/sheet1.xml',
          },
        ]
      : sheets.flatMap((s) =>
          !s.hidden && s.rel?.type.endsWith('/worksheet')
            ? [{ name: s.name, path: resolveTarget(s.rel.target) }]
            : []
        );
  const sharedXml = await read(sharedStringsPath);
  const shared = sharedXml ? sharedStrings(sharedXml) : [];
  const out: { name: string; rows: string[][] }[] = [];
  for (const t of targets) {
    const xml = await read(t.path);
    if (xml !== null) {
      out.push({ name: t.name, rows: sheetRows(xml, shared, budget) });
    }
  }
  return out;
}
