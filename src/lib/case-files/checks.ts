/**
 * Case document files: the pure checks and naming the server jobs call.
 * No I/O, no database. Ported from the 021 package (`src/case/files.ts`).
 *
 *   runChecks - mime (allowed AND magic bytes), size, readable (PDF page
 *     count through pdf-lib; image header), resolution (image short side),
 *     expiry. There is no OCR: expiry dates come from the caller.
 *   renameFor - byte-identical to the SQL `case_file_render_name`; the
 *     vectors in `render-name.vectors.json` pin both sides.
 *   sanitizeOriginalName - the name a file is registered under.
 *
 * Never throws on bytes, mime or spec: a file a check cannot judge fails
 * that check.
 */
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

/** The closed list: the SQL table check refuses any other `allowed_mime`. */
export const CASE_FILE_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;
export type CaseFileMime = (typeof CASE_FILE_MIME)[number];

export const DEFAULT_MAX_MB = 10;
export const MIN_SHORT_SIDE_PX = 600;
const MIB = 1024 * 1024;

export type CheckName = 'mime' | 'size' | 'readable' | 'resolution' | 'expiry';
export interface Check {
  name: CheckName;
  ok: boolean;
  detail: string | null;
}
export interface CheckOutcome {
  ok: boolean;
  checks: Check[];
  pages: number | null;
}
export interface CheckSpec {
  maxMb: number;
  allowedMime: readonly string[];
  minValidDays: number | null;
}

/** Lower case, parameters dropped (`; charset=…`), trimmed. */
export function normalizeMime(m: string): string {
  return m.split(';')[0].trim().toLowerCase();
}

const MAGIC: Readonly<Record<CaseFileMime, readonly number[]>> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

function isCaseFileMime(m: string): m is CaseFileMime {
  return (CASE_FILE_MIME as readonly string[]).includes(m);
}

function magicMatches(bytes: Uint8Array, mime: string): boolean {
  if (!isCaseFileMime(mime)) return false;
  const m = MAGIC[mime];
  return bytes.length >= m.length && m.every((b, i) => bytes[i] === b);
}

/**
 * Width and height of a PNG (IHDR) or JPEG (first SOFn); null when the
 * header cannot be parsed. Every read is bounds-checked first: a malformed
 * or truncated file returns null, never reads out of range or loops.
 */
export function imageSize(
  bytes: Uint8Array,
  mime: string
): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    // signature (8) + length (4) + "IHDR" (4) + width (4) + height (4)
    if (bytes.length < 24) return null;
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      // Standalone markers carry no length: SOI, TEM, RST0..7.
      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        // FF Cn, length (2), precision (1), height (2), width (2)
        if (i + 9 > bytes.length) return null;
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      if (marker === 0xd9 || len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-13-45 and 2026-02-30). */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return doc.isEncrypted ? 0 : doc.getPageCount();
  } catch {
    return 0;
  }
}

/**
 * The automated checks of one file against its spec row (null = the
 * defaults: 10 MB, the closed MIME list, no expiry rule). `today` and
 * `expiresOn` are YYYY-MM-DD. Order as the package: mime, size, then for a
 * file whose mime passed: readable (PDF) or readable/resolution (image),
 * then expiry when the spec has `minValidDays` and `expiresOn` is given.
 * `pages`: the PDF page count, 1 for an image, else null.
 */
export async function runChecks(
  bytes: Uint8Array,
  mime: string,
  spec: CheckSpec | null,
  opts: { today: string; expiresOn?: string | null }
): Promise<CheckOutcome> {
  const maxBytes = (spec?.maxMb ?? DEFAULT_MAX_MB) * MIB;
  const allowed = (spec?.allowedMime ?? CASE_FILE_MIME).map(normalizeMime);
  const type = normalizeMime(mime);
  const checks: Check[] = [];
  let pages: number | null = null;

  const mimeAllowed = isCaseFileMime(type) && allowed.includes(type);
  const magicOk = mimeAllowed && magicMatches(bytes, type);
  checks.push({
    name: 'mime',
    ok: magicOk,
    detail: !mimeAllowed ? 'not_allowed' : magicOk ? null : 'magic_mismatch',
  });

  const sizeOk = bytes.length <= maxBytes;
  checks.push({
    name: 'size',
    ok: sizeOk,
    detail: sizeOk ? null : 'too_large',
  });

  if (magicOk && type === 'application/pdf') {
    // Never hand the parser more than the limit allows.
    const n = await pdfPageCount(bytes.subarray(0, Math.max(0, maxBytes)));
    checks.push({
      name: 'readable',
      ok: n > 0,
      detail: n > 0 ? null : 'unreadable',
    });
    pages = n > 0 ? n : null;
  } else if (magicOk) {
    const size = imageSize(bytes, type);
    if (!size) {
      checks.push({ name: 'readable', ok: false, detail: 'unreadable' });
    } else {
      const ok = Math.min(size.width, size.height) >= MIN_SHORT_SIDE_PX;
      checks.push({
        name: 'resolution',
        ok,
        detail: ok ? `${size.width}x${size.height}` : 'low_resolution',
      });
      pages = 1;
    }
  }

  const minDays = spec?.minValidDays ?? null;
  if (minDays !== null && opts.expiresOn) {
    if (!isRealDate(opts.today) || !isRealDate(opts.expiresOn)) {
      checks.push({ name: 'expiry', ok: false, detail: 'invalid_date' });
    } else {
      const ok = opts.expiresOn >= addDays(opts.today, minDays);
      checks.push({ name: 'expiry', ok, detail: ok ? null : 'expiring' });
    }
  }

  return { ok: checks.every((c) => c.ok), checks, pages };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The name a file is registered under (021 R3-L3): control characters
 * (C0, DEL, C1) and path separators removed, leading dots and spaces
 * stripped (no '..', no hidden name), cut to 200 characters (code points,
 * so a pair is never split); 'file' when nothing is left.
 */
export function sanitizeOriginalName(name: string): string {
  const v = name
    .replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  const cut = Array.from(v).slice(0, 200).join('').trim();
  return cut === '' ? 'file' : cut;
}

export interface RenameVars {
  case: string | null;
  company: string | null;
  doc: string | null;
  /** YYYY-MM-DD */
  date: string;
}

// An exact match, as the SQL CASE: 'IMAGE/PNG' gets no extension.
function extFor(mime: string | null): string {
  switch (mime) {
    case 'application/pdf':
      return '.pdf';
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    default:
      return '';
  }
}

/**
 * The stored name of a classified file. Byte-identical to the SQL
 * `case_file_render_name(pattern, case, company, doc, date, mime)`:
 * placeholders replaced literally in the order case, company, doc,
 * yyyymmdd (each over the previous result); every run outside
 * [A-Za-z0-9._-] becomes '_'; leading and trailing [._-] removed; cut to
 * 120 characters with the extension, trailing [._-] removed again; 'file'
 * when empty. Throws RangeError on a date that is not a real YYYY-MM-DD
 * (the SQL takes a `date`, so such a value cannot reach it).
 */
export function renameFor(
  pattern: string | null,
  vars: RenameVars,
  mime: string | null
): string {
  if (!isRealDate(vars.date)) {
    throw new RangeError(`date must be a real YYYY-MM-DD: ${vars.date}`);
  }
  const ext = extFor(mime);
  // A function replacement keeps '$&' and friends literal, as SQL replace().
  const lit = (s: string | null) => () => s ?? '';
  let v = (pattern ?? '')
    .replaceAll('{{case}}', lit(vars.case))
    .replaceAll('{{company}}', lit(vars.company))
    .replaceAll('{{doc}}', lit(vars.doc))
    .replaceAll('{{yyyymmdd}}', lit(vars.date.replaceAll('-', '')));
  v = v.replace(/[^A-Za-z0-9._-]+/g, '_');
  v = v.replace(/^[._-]+|[._-]+$/g, '');
  v = v.slice(0, 120 - ext.length).replace(/[._-]+$/, '');
  if (v === '') v = 'file';
  return v + ext;
}
