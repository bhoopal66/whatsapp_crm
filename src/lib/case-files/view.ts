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

/**
 * The classify body that brings a replaced version back (270); null when it
 * is not one. `reuse` holds the server to that: on a stale screen the same
 * classify would re-check a file that counts by now.
 */
export function reuseBody(
  file: CaseFileView
): { docKey: string; reuse: true; expiresOn?: string } | null {
  if (file.status !== 'superseded' || file.docKey === null) return null;
  return {
    docKey: file.docKey,
    reuse: true,
    ...(file.expiresOn ? { expiresOn: file.expiresOn } : {}),
  };
}

/**
 * The `CaseFiles` key to show when a file an attach or upload answered (201)
 * does not count: it failed its checks, or a newer one was accepted while
 * they ran. null when it was filed.
 */
export function filedToastKey(json: unknown): string | null {
  const file = (json as { file?: { status?: unknown } | null } | null)?.file;
  if (file?.status === 'failed') return 'checkedFailed';
  return file?.status === 'superseded' ? 'checkedSuperseded' : null;
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
  'ALREADY_FILED_AS',
  'REUSE_WOULD_FAIL',
  'STORAGE_UNAVAILABLE',
]);

/** The `CaseFiles` catalogue key for a refusal; `errors.generic` if unknown. */
export function caseFileErrorKey(status: number, code: unknown): string {
  if (typeof code === 'string' && ERROR_CODES.has(code))
    return `errors.${code}`;
  if (status === 403) return 'errors.NOT_ALLOWED';
  if (status === 413) return 'errors.FILE_TOO_LARGE';
  return 'errors.generic';
}

/**
 * The document a refused file is already filed as, which the dialog names
 * before it offers the move; null for any other answer.
 */
export function filedElsewhere(status: number, json: unknown): string | null {
  const j = obj(json);
  return status === 409 && j?.code === 'ALREADY_FILED_AS'
    ? str(j.filedAs)
    : null;
}

/**
 * The catalogue keys of the checks an earlier version would fail now
 * (REUSE_WOULD_FAIL), which the dialog lists; empty for any other answer.
 */
export function reuseFailures(status: number, json: unknown): string[] {
  const j = obj(json);
  if (status !== 409 || j?.code !== 'REUSE_WOULD_FAIL') return [];
  return (Array.isArray(j.failedChecks) ? j.failedChecks : [])
    .map(obj)
    .map((c) =>
      checkFailureKey({
        name: str(c?.name) ?? '',
        ok: false,
        detail: str(c?.detail),
      })
    );
}

/** YYYY-MM-DD or empty: the optional expiry field's value. */
export function validExpiry(value: string): boolean {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

// ------------------------------------------------------------ Case file build

export interface CaseBuildItem {
  position: number;
  docKey: string;
  fileId: string;
  renamedName: string | null;
  pages: number | null;
  sha256: string;
}

export interface CaseBuildView {
  buildId: string;
  version: number;
  merged: boolean;
  manifest: CaseBuildItem[];
  sha256: string;
  status: 'ready' | 'superseded';
  builtAt: string | null;
}

function parseBuildItem(v: unknown): CaseBuildItem | null {
  const r = obj(v);
  const docKey = str(r?.docKey);
  const fileId = str(r?.fileId);
  const position = num(r?.position);
  if (!r || !docKey || !fileId || position === null) return null;
  return {
    position,
    docKey,
    fileId,
    renamedName: str(r.renamedName),
    pages: num(r.pages),
    sha256: str(r.sha256) ?? '',
  };
}

function parseBuild(v: unknown): CaseBuildView | null {
  const b = obj(v);
  const buildId = str(b?.buildId);
  const version = num(b?.version);
  if (!b || !buildId || version === null) return null;
  if (b.status !== 'ready' && b.status !== 'superseded') return null;
  return {
    buildId,
    version,
    merged: b.merged === true,
    manifest: (Array.isArray(b.manifest) ? b.manifest : [])
      .map(parseBuildItem)
      .filter((i): i is CaseBuildItem => i !== null)
      .sort((a, c) => a.position - c.position),
    sha256: str(b.sha256) ?? '',
    status: b.status,
    builtAt: str(b.builtAt),
  };
}

/**
 * Parse GET / POST `/api/cases/[id]/build`: `{ build }`. `{ build: null }`
 * is a valid "none yet"; any other shape is null, so the caller can tell
 * "none" from "unreadable".
 */
export function parseCaseBuild(
  json: unknown
): { build: CaseBuildView | null } | null {
  const root = obj(json);
  if (!root || !('build' in root)) return null;
  if (root.build === null) return { build: null };
  const build = parseBuild(root.build);
  return build ? { build } : null;
}

export type CaseBuildState = 'none' | 'current' | 'stale';

/** A build is stale once the case is not File ready or it was superseded. */
export function buildState(
  ready: boolean,
  build: Pick<CaseBuildView, 'status'> | null
): CaseBuildState {
  if (!build) return 'none';
  return ready && build.status === 'ready' ? 'current' : 'stale';
}

/** The first 12 characters of a digest, for display. */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

const BUILD_ERROR_CODES = new Set([
  'NOT_ALLOWED',
  'FILE_NOT_READY',
  'CASE_CLOSED',
  'BUILD_INVALID',
  'BUILD_STALE',
  'BUILD_TOO_LARGE',
  'FORM_NOT_FLATTENED',
  'FILE_NOT_FOUND',
  'NOT_CONFIGURED',
]);

/** The `CaseFiles` key for a build / download refusal. */
export function buildErrorKey(status: number, code: unknown): string {
  if (typeof code === 'string' && BUILD_ERROR_CODES.has(code))
    return `buildErrors.${code}`;
  if (status === 403) return 'buildErrors.NOT_ALLOWED';
  return 'buildErrors.generic';
}

/** The `url` of a download answer, only when it is an http(s) URL. */
export function parseDownloadUrl(json: unknown): string | null {
  const url = str(obj(json)?.url);
  if (!url) return null;
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:' ? url : null;
  } catch {
    return null;
  }
}
