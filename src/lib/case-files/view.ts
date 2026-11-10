/**
 * Case document files (migration 181) as the case page's Documents tab
 * shows them. Pure and browser-safe (no node imports), so the shaping is
 * unit-tested: parse GET /api/cases/[id]/files defensively, group the
 * files per document, pick each document's current version and turn
 * its checks into readable lines.
 *
 * The current version mirrors 181's `case_file_ready`: a newer failed
 * version outranks an older passed one, so the newest non-superseded
 * version of a document is the one the chip describes.
 */
import { formatBytes } from '@/lib/chat/view';

export type CaseFileStatus =
  'unclassified' | 'pending_checks' | 'passed' | 'failed' | 'superseded';

const STATUSES: readonly CaseFileStatus[] = [
  'unclassified',
  'pending_checks',
  'passed',
  'failed',
  'superseded',
];

/** What may be uploaded; equals `CASE_FILE_MIME` (checks.ts, node-only). */
export const CASE_FILE_UPLOAD_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;
/** The file input's `accept`. */
export const CASE_FILE_ACCEPT = CASE_FILE_UPLOAD_MIME.join(',');
/** The server's upload ceiling (`MAX_UPLOAD_BYTES`), checked before sending. */
export const CASE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface CaseFileCheck {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface CaseFileView {
  id: string;
  customerDocumentId: string;
  docKey: string | null;
  version: number | null;
  status: CaseFileStatus;
  classifySeq: number;
  checks: CaseFileCheck[] | null;
  pages: number | null;
  expiresOn: string | null;
  renamedName: string | null;
  registeredAt: string;
  originalName: string | null;
  mime: string | null;
  sizeBytes: number | null;
}

export interface CaseFileSpecView {
  docKey: string;
  position: number;
  required: boolean;
  maxMb: number | null;
  minValidDays: number | null;
}

export interface CaseFilesData {
  files: CaseFileView[];
  ready: boolean;
  spec: CaseFileSpecView[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function parseCheck(v: unknown): CaseFileCheck | null {
  const c = obj(v);
  const name = str(c?.name);
  if (!c || !name || typeof c.ok !== 'boolean') return null;
  return { name, ok: c.ok, detail: str(c.detail) };
}

function parseFile(v: unknown): CaseFileView | null {
  const r = obj(v);
  const id = str(r?.id);
  const status = r?.status;
  if (
    !r ||
    !id ||
    typeof status !== 'string' ||
    !(STATUSES as readonly string[]).includes(status)
  )
    return null;
  const doc = obj(r.document);
  return {
    id,
    customerDocumentId: str(r.customerDocumentId) ?? '',
    docKey: str(r.docKey),
    version: num(r.version),
    status: status as CaseFileStatus,
    classifySeq: num(r.classifySeq) ?? 0,
    checks: Array.isArray(r.checks)
      ? r.checks.map(parseCheck).filter((c): c is CaseFileCheck => c !== null)
      : null,
    pages: num(r.pages),
    expiresOn: str(r.expiresOn),
    renamedName: str(r.renamedName),
    registeredAt: str(r.registeredAt) ?? '',
    originalName: str(doc?.originalName),
    mime: str(doc?.mime),
    sizeBytes: num(doc?.sizeBytes),
  };
}

function parseSpec(v: unknown): CaseFileSpecView | null {
  const r = obj(v);
  const docKey = str(r?.docKey);
  if (!r || !docKey) return null;
  return {
    docKey,
    position: num(r.position) ?? 0,
    required: r.required === true,
    maxMb: num(r.maxMb),
    minValidDays: num(r.minValidDays),
  };
}

/** GET /api/cases/[id]/files; null when the body is not that shape. */
export function parseCaseFiles(json: unknown): CaseFilesData | null {
  const j = obj(json);
  if (!j || !Array.isArray(j.files)) return null;
  const spec = (Array.isArray(j.spec) ? j.spec : [])
    .map(parseSpec)
    .filter((s): s is CaseFileSpecView => s !== null);
  spec.sort((a, b) => a.position - b.position);
  return {
    files: j.files.map(parseFile).filter((f): f is CaseFileView => f !== null),
    ready: j.ready === true,
    spec,
  };
}

export type CaseFileChip = 'missing' | 'checking' | 'passed' | 'failed';

export interface CaseFileDocRow {
  spec: CaseFileSpecView;
  /** The newest non-superseded version, or null. */
  current: CaseFileView | null;
  /** Every other version of the document, newest first. */
  history: CaseFileView[];
  chip: CaseFileChip;
  /** The current version's failed checks. */
  failures: CaseFileCheck[];
}

export interface CaseFilesView {
  ready: boolean;
  rows: CaseFileDocRow[];
  /** Files no document has been chosen for yet, newest first. */
  unclassified: CaseFileView[];
}

/** Newest first: higher version, an unversioned one above all, then time. */
function newestFirst(a: CaseFileView, b: CaseFileView): number {
  const va = a.version ?? Number.POSITIVE_INFINITY;
  const vb = b.version ?? Number.POSITIVE_INFINITY;
  if (va !== vb) return vb > va ? 1 : -1;
  return b.registeredAt.localeCompare(a.registeredAt);
}

export function chipFor(current: CaseFileView | null): CaseFileChip {
  switch (current?.status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'pending_checks':
    case 'unclassified':
      return 'checking';
    default:
      return 'missing';
  }
}

/** The failed checks, in the order the server ran them. */
export function checkFailures(
  checks: readonly CaseFileCheck[] | null
): CaseFileCheck[] {
  return (checks ?? []).filter((c) => !c.ok);
}

/** One row per spec document (position order) plus the unclassified list. */
export function buildCaseFilesView(data: CaseFilesData): CaseFilesView {
  const byKey = new Map<string, CaseFileView[]>();
  const unclassified: CaseFileView[] = [];
  for (const f of data.files) {
    if (f.status === 'unclassified' || f.docKey === null) {
      unclassified.push(f);
      continue;
    }
    const list = byKey.get(f.docKey) ?? [];
    list.push(f);
    byKey.set(f.docKey, list);
  }
  const rows = data.spec.map((spec) => {
    const versions = [...(byKey.get(spec.docKey) ?? [])].sort(newestFirst);
    const current = versions.find((f) => f.status !== 'superseded') ?? null;
    return {
      spec,
      current,
      history: versions.filter((f) => f !== current),
      chip: chipFor(current),
      failures:
        current?.status === 'failed' ? checkFailures(current.checks) : [],
    };
  });
  unclassified.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  return { ready: data.ready, rows, unclassified };
}

const KNOWN_DETAILS = new Set([
  'too_large',
  'low_resolution',
  'magic_mismatch',
  'unreadable',
  'expiring',
  'not_allowed',
  'invalid_date',
]);
const KNOWN_CHECKS = new Set([
  'mime',
  'size',
  'readable',
  'resolution',
  'expiry',
]);

/**
 * The `CaseFiles` catalogue key for a failed check: its detail when known
 * (`checks.detail.too_large`), else its name (`checks.name.size`), else
 * the generic line.
 */
export function checkFailureKey(c: CaseFileCheck): string {
  if (c.detail && KNOWN_DETAILS.has(c.detail))
    return `checks.detail.${c.detail}`;
  if (KNOWN_CHECKS.has(c.name)) return `checks.name.${c.name}`;
  return 'checks.other';
}

/** A human-readable size, or null when unknown. */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  return formatBytes(bytes);
}

/** Why a picked file cannot be uploaded, before sending it; null when fine. */
export function uploadProblem(file: {
  type: string;
  size: number;
}): 'mime' | 'size' | null {
  const mime = file.type.split(';')[0].trim().toLowerCase();
  if (!(CASE_FILE_UPLOAD_MIME as readonly string[]).includes(mime))
    return 'mime';
  if (file.size > CASE_FILE_MAX_BYTES) return 'size';
  return null;
}

/** A customer document the attach dialog offers: a PDF or image with bytes. */
export function isAttachableDocument(doc: {
  mime: string | null;
  status: string;
}): boolean {
  const mime = (doc.mime ?? '').split(';')[0].trim().toLowerCase();
  return (
    doc.status !== 'failed' &&
    (CASE_FILE_UPLOAD_MIME as readonly string[]).includes(mime)
  );
}

const ERROR_CODES = new Set([
  'NOT_ALLOWED',
  'CASE_NOT_FOUND',
  'FILE_NOT_FOUND',
  'CASE_CLOSED',
  'CHECK_MISMATCH',
  'FILE_STATE',
  'NO_CONTACT',
  'DOCUMENT_NOT_RECORDED',
  'DOCUMENT_INVALID',
  'FILE_TOO_LARGE',
  'DOC_NOT_REQUIRED',
  'VALIDATION_FAILED',
  'MIME_NOT_ALLOWED',
  'FILE_INVALID',
]);

/** The `CaseFiles` catalogue key for a refusal; `errors.generic` if unknown. */
export function caseFileErrorKey(status: number, code: unknown): string {
  if (typeof code === 'string' && ERROR_CODES.has(code))
    return `errors.${code}`;
  if (status === 403) return 'errors.NOT_ALLOWED';
  if (status === 413) return 'errors.FILE_TOO_LARGE';
  return 'errors.generic';
}

/** YYYY-MM-DD or empty: the optional expiry field's value. */
export function validExpiry(value: string): boolean {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}
