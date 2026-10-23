/**
 * Reads the first worksheet of an Excel `.xlsx` file into rows of cell
 * strings, row 0 being the header (readXlsxTable), or every visible
 * worksheet with its rows in place (readXlsxSheets). Broadcast audiences arrive as Excel
 * exports more often than as CSV, and re-saving one as CSV in Excel
 * mangles long numbers into "9.71505E+11" — so the file is read as it
 * is, in the browser, with no spreadsheet library: an `.xlsx` is a ZIP
 * of XML parts, and a contact list needs only the cell text.
 *
 * A hand scan rather than DOMParser because the tests run in node. Dates
 * are Excel serial numbers and are returned as such, not converted.
 *
 * The file is untrusted (an admin's upload on the server, anyone's
 * spreadsheet in the browser), and both of its layers can claim far
 * more than it holds: a few KB of deflate can inflate to gigabytes, and
 * one `<row r="2000000000">` would otherwise be padded out row by row.
 * So every read runs on a budget (XLSX_LIMITS) and throws past it.
 *
 * The XML is scanned with indexOf, never with a lazy regex such as
 * `<row\b…>([\s\S]*?)<\/row>`: on an entry of openers that are never
 * closed each match attempt runs to the end of the text and fails, so
 * 50 MB of `<row>` blocks the event loop for hours. Every search here
 * starts where the previous one ended, which keeps a read linear.
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

const isSpace = (ch: string) => /\s/.test(ch);

/** True when `ch` (undefined past the end) is not a regex word character. */
const isBoundary = (ch: string | undefined) =>
  ch === undefined || !/\w/.test(ch);

/**
 * An attribute's decoded value from a tag's attribute text, or null: the
 * first `name = "…"` (or '…') that starts the text or follows whitespace.
 */
function attr(attrs: string, name: string): string | null {
  for (
    let at = attrs.indexOf(name);
    at !== -1;
    at = attrs.indexOf(name, at + 1)
  ) {
    if (at > 0 && !isSpace(attrs[at - 1])) continue;
    let i = at + name.length;
    while (i < attrs.length && isSpace(attrs[i])) i++;
    if (attrs[i] !== '=') continue;
    i++;
    while (i < attrs.length && isSpace(attrs[i])) i++;
    const quote = attrs[i];
    if (quote !== '"' && quote !== "'") continue;
    // Only the last quote of each kind can lack a partner, so this
    // search fails at most twice per call.
    const end = attrs.indexOf(quote, i + 1);
    if (end !== -1) return decodeText(attrs.slice(i + 1, end));
  }
  return null;
}

/**
 * Where the next `<name` opening tag starts at or after `from`, or -1.
 * The name must end there (`<c` is not `<col`, `<row` not `<rowBreaks`).
 */
function nextOpener(xml: string, name: string, from: number): number {
  const open = `<${name}`;
  for (let at = xml.indexOf(open, from); at !== -1;) {
    if (isBoundary(xml[at + open.length])) return at;
    at = xml.indexOf(open, at + open.length);
  }
  return -1;
}

/**
 * The attribute text of every `<name …>` opening tag, in order. A tag
 * with no `>` after it ends the scan: no later one has one either.
 */
function* openingTags(xml: string, name: string): Generator<string> {
  for (let at = nextOpener(xml, name, 0); at !== -1;) {
    const gt = xml.indexOf('>', at);
    if (gt === -1) return;
    yield xml.slice(at + name.length + 1, gt);
    at = nextOpener(xml, name, gt + 1);
  }
}

/**
 * Every `<name …>…</name>` and `<name …/>` element, in order, as its
 * attribute text and body ('' when self-closing; with `selfClosing`
 * false, `<name/>` is an opening tag like any other). An element that is
 * never closed is skipped, as a regex would skip it, but its search for
 * `</name>` is not repeated: once that has run off the end, no later
 * element can be closed either, and only self-closing ones still count.
 */
function* elements(
  xml: string,
  name: string,
  selfClosing = true
): Generator<{ attrs: string; body: string }> {
  const close = `</${name}>`;
  let closable = true;
  for (let at = nextOpener(xml, name, 0); at !== -1;) {
    const gt = xml.indexOf('>', at);
    if (gt === -1) return;
    const attrsFrom = at + name.length + 1;
    let next = gt + 1;
    if (selfClosing && gt > attrsFrom && xml[gt - 1] === '/') {
      yield { attrs: xml.slice(attrsFrom, gt - 1), body: '' };
    } else if (closable) {
      const end = xml.indexOf(close, gt + 1);
      if (end === -1) {
        closable = false;
      } else {
        yield { attrs: xml.slice(attrsFrom, gt), body: xml.slice(gt + 1, end) };
        next = end + close.length;
      }
    }
    at = nextOpener(xml, name, next);
  }
}

/** The first element of `elements`, or null. */
function firstElement(xml: string, name: string, selfClosing = true) {
  for (const el of elements(xml, name, selfClosing)) return el;
  return null;
}

/**
 * `xml` without its `<rPh>…</rPh>` runs. As before, a run's end is the
 * first `</rPh>` after it, whatever lies between; with none left, the
 * rest is kept.
 */
function withoutPhonetics(xml: string): string {
  const close = '</rPh>';
  let out = '';
  let kept = 0;
  for (let at = nextOpener(xml, 'rPh', 0); at !== -1;) {
    const end = xml.indexOf(close, at + 4);
    if (end === -1) break;
    out += xml.slice(kept, at);
    kept = end + close.length;
    at = nextOpener(xml, 'rPh', kept);
  }
  return out + xml.slice(kept);
}

/**
 * The text of a shared string or an inline string: every `<t>` run
 * concatenated (rich text splits one cell across several), without the
 * `<rPh>` phonetic guides Japanese files add above the text.
 */
function richText(xml: string): string {
  let text = '';
  for (const t of elements(withoutPhonetics(xml), 't')) {
    text += decodeText(t.body);
  }
  return text;
}

function sharedStrings(xml: string): string[] {
  return Array.from(elements(xml, 'si'), (si) => richText(si.body));
}

/**
 * The longest reference Excel writes is "$XFD$1048576". A longer one is
 * refused rather than read, so no reference costs more than a few steps.
 */
const MAX_REF_LENGTH = 12;

function checkRef(ref: string) {
  if (ref.length > MAX_REF_LENGTH) {
    throw new Error(
      `Cell reference "${ref.slice(0, MAX_REF_LENGTH)}…" is too long`
    );
  }
}

/** "B3" → 1; null when the reference has no column letters. */
function columnIndex(ref: string | null): number | null {
  if (!ref) return null;
  checkRef(ref);
  const from = ref[0] === '$' ? 1 : 0;
  let index = 0;
  let i = from;
  for (; i < ref.length; i++) {
    // ASCII letters only, either case: `| 0x20` lowers A-Z and leaves
    // nothing else in a-z.
    const code = ref.charCodeAt(i) | 0x20;
    if (code < 97 || code > 122) break;
    index = index * 26 + (code - 96);
  }
  return i === from ? null : index - 1;
}

/** "B3" → 2 (0-based); null when the reference has no row digits. */
function rowIndex(ref: string | null): number | null {
  if (!ref) return null;
  checkRef(ref);
  let i = ref.length;
  while (i > 0 && ref[i - 1] >= '0' && ref[i - 1] <= '9') i--;
  return i === ref.length ? null : Number(ref.slice(i)) - 1;
}

function cellValue(type: string | null, body: string, shared: string[]) {
  const v = firstElement(body, 'v');
  const raw = v ? decodeText(v.body) : '';
  switch (type) {
    case 's':
      // An empty `<c t="s"/>` is a blank cell, not shared string 0
      // (`Number('')` is 0, which would repeat the first header).
      return raw.trim() === '' ? '' : (shared[Number(raw)] ?? '');
    case 'inlineStr': {
      // `<is/>` was never self-closing here: it waits for an `</is>`.
      const is = firstElement(body, 'is', false);
      return is ? richText(is.body) : '';
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
  for (const row of elements(xml, 'row')) {
    const cells: string[] = [];
    for (const c of elements(row.body, 'c')) {
      const ref = attr(c.attrs, 'r');
      const col = columnIndex(ref) ?? cells.length;
      if (col >= XLSX_MAX_COLUMNS) {
        throw new Error(
          `Cell ${ref ?? `#${col + 1}`} is beyond Excel's last column (XFD)`
        );
      }
      spendCells(budget, Math.max(0, col + 1 - cells.length));
      while (cells.length < col) cells.push('');
      cells[col] = cellValue(attr(c.attrs, 't'), c.body, shared);
    }
    const ref = attr(row.attrs, 'r');
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
  return Array.from(openingTags(xml, 'Relationship'), (a) => ({
    id: attr(a, 'Id') ?? '',
    type: attr(a, 'Type') ?? '',
    target: attr(a, 'Target') ?? '',
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
  for (const a of workbook ? openingTags(workbook, 'sheet') : []) {
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
