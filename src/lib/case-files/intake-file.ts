/**
 * Staff intake of case document files (migration 181), ported from the
 * 021 package's `intakeFile` / `classifyAndCheck`.
 *
 *   uploadStaffFile        - bytes from a person: refused (MIME, size, the
 *     181 can-register check) before anything is written, then stored
 *     content-addressed in the private 'case-files' bucket, recorded as a
 *     customer document (180, so the NAS worker files it), registered on
 *     the case and, with a doc_key, classified and checked.
 *   attachCustomerDocument - a document the customer already sent:
 *     register, classify, check.
 *   classifyAndCheck       - classify (the SQL hands out classify_seq),
 *     read the bytes, run the checks, post them under that classify_seq.
 *     A file is never left pending: unreadable bytes post a failed
 *     'readable' check.
 *
 * TENANCY: the caller (a route) has already checked the case belongs to
 * the actor's active account. Every function takes its I/O as arguments
 * (`admin` for RPCs and reads, `deps` for storage, fetch and the clock).
 */
import { recordCustomerDocumentInternal } from '@/lib/customer-docs/record';

import { readDocumentBytes, type CaseFilesStorage } from './bytes';
import {
  CASE_FILE_MIME,
  DEFAULT_MAX_MB,
  isRealDate,
  magicMatches,
  normalizeMime,
  runChecks,
  sanitizeOriginalName,
  sha256Hex,
  type Check,
  type CaseFileMime,
} from './checks';
import {
  CaseFilesRefusedError,
  CaseFilesStore,
  CaseFilesStoreError,
  type CaseFile,
  type CaseFilesDb,
} from './store';

export const CASE_FILES_BUCKET = 'case-files';
/** The upload cap: the checks' default size limit. */
export const MAX_UPLOAD_BYTES = DEFAULT_MAX_MB * 1024 * 1024;

export interface CaseFilesDeps {
  /** The service-role storage client (`admin.storage`). */
  storage: CaseFilesStorage;
  fetch?: typeof fetch;
  /** Defaults to `serverSupabaseUrl()`. */
  internalBaseUrl?: string;
  clock?: () => Date;
}

export interface CheckOutcomeResult {
  fileId: string;
  status: 'passed' | 'failed';
  classifySeq: number;
  version: number;
  renamedName: string;
  checks: Check[];
  pages: number | null;
}

const RETRY_CODES = new Set(['40P01', '40001']);

/**
 * Runs a single-statement step once more when Postgres aborted it as a
 * deadlock (40P01) or a serialization failure (40001). Each RPC is its own
 * autocommit transaction, so a retry repeats nothing committed.
 */
export async function retryOnConflict<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !RETRY_CODES.has(code)) throw err;
    return step();
  }
}

function assertExpiresOn(expiresOn: string | null | undefined): void {
  if (expiresOn !== undefined && expiresOn !== null && !isRealDate(expiresOn))
    throw new CaseFilesRefusedError('VALIDATION_FAILED');
}

const today = (clock: () => Date) => clock().toISOString().slice(0, 10);

const EXT: Readonly<Record<CaseFileMime, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function isCaseFileMime(m: string): m is CaseFileMime {
  return (CASE_FILE_MIME as readonly string[]).includes(m);
}

/** Storage answers 409 / "already exists" for an object at that path. */
export function isAlreadyExists(error: unknown): boolean {
  const e = error as {
    statusCode?: unknown;
    status?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (String(e?.statusCode ?? e?.status ?? '') === '409') return true;
  return /already exists|duplicate/i.test(
    `${String(e?.error ?? '')} ${String(e?.message ?? '')}`
  );
}

async function loadFile(store: CaseFilesStore, fileId: string) {
  const file = await store.getFile(fileId);
  if (!file) throw new CaseFilesRefusedError('FILE_NOT_FOUND');
  return file;
}

export async function classifyAndCheck(input: {
  admin: CaseFilesDb;
  /** NULL = the system intake (WhatsApp tap-to-classify). */
  actor: string | null;
  fileId: string;
  docKey: string;
  expiresOn?: string | null;
  /** YYYY-MM-DD, the day the expiry rule counts from. */
  today: string;
  deps: CaseFilesDeps;
}): Promise<CheckOutcomeResult> {
  const { admin, actor, fileId, docKey, deps } = input;
  const expiresOn = input.expiresOn ?? null;
  assertExpiresOn(expiresOn);
  const store = new CaseFilesStore(admin);

  // Reads first: a failure here leaves the file as it was, not pending.
  const file = await loadFile(store, fileId);
  const [doc, spec] = await Promise.all([
    store.getDocument(file.customerDocumentId),
    store.specRows(file.caseId),
  ]);
  const row = spec.find((s) => s.docKey === docKey) ?? null;

  const cls = await retryOnConflict(() =>
    store.classify(actor, fileId, docKey)
  );

  const bytes = doc
    ? await readDocumentBytes(doc, {
        storage: deps.storage,
        fetch: deps.fetch,
        internalBaseUrl: deps.internalBaseUrl,
      })
    : null;

  let checks: Check[];
  let pages: number | null = null;
  if (!bytes) {
    checks = [{ name: 'readable', ok: false, detail: 'storage read failed' }];
  } else {
    const out = await runChecks(
      bytes,
      doc?.mime ?? '',
      row
        ? {
            maxMb: row.maxMb ?? DEFAULT_MAX_MB,
            allowedMime: row.allowedMime ?? CASE_FILE_MIME,
            minValidDays: row.minValidDays,
          }
        : null,
      { today: input.today, expiresOn }
    );
    checks = out.checks;
    pages = out.pages;
  }

  const status = await retryOnConflict(() =>
    store.postCheckResult(
      fileId,
      docKey,
      cls.classifySeq,
      checks,
      pages,
      expiresOn
    )
  );
  return { fileId, status, ...cls, checks, pages };
}

export async function attachCustomerDocument(input: {
  admin: CaseFilesDb;
  actor: string;
  caseId: string;
  customerDocumentId: string;
  docKey: string;
  expiresOn?: string | null;
  deps: CaseFilesDeps;
}): Promise<CaseFile> {
  assertExpiresOn(input.expiresOn);
  const store = new CaseFilesStore(input.admin);
  const fileId = await store.register(
    input.actor,
    input.caseId,
    input.customerDocumentId
  );
  await classifyAndCheck({
    admin: input.admin,
    actor: input.actor,
    fileId,
    docKey: input.docKey,
    expiresOn: input.expiresOn,
    today: today(input.deps.clock ?? (() => new Date())),
    deps: input.deps,
  });
  return loadFile(store, fileId);
}

export async function uploadStaffFile(input: {
  admin: CaseFilesDb;
  actor: string;
  caseId: string;
  accountId: string;
  /** The case's customer contact. */
  contactId: string;
  file: { bytes: Uint8Array; mime: string; originalName: string };
  docKey?: string | null;
  expiresOn?: string | null;
  deps: CaseFilesDeps;
}): Promise<CaseFile> {
  const { admin, actor, caseId, deps } = input;
  const clock = deps.clock ?? (() => new Date());

  // Refusals that need no database, before any write.
  assertExpiresOn(input.expiresOn);
  const mime = normalizeMime(input.file.mime);
  if (!isCaseFileMime(mime))
    throw new CaseFilesRefusedError('MIME_NOT_ALLOWED');
  if (input.file.bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new CaseFilesRefusedError('FILE_TOO_LARGE');
  // The browser's declared type is only a claim: the bytes must agree
  // before anything is stored or reaches the customer's NAS folder, even
  // when no required document is picked (and so no checks run yet).
  if (!magicMatches(input.file.bytes, mime))
    throw new CaseFilesRefusedError('MIME_NOT_ALLOWED');

  const store = new CaseFilesStore(admin);
  // The case's own refusals (role, closed, no contact) before any bytes land.
  await store.assertCanRegister(actor, caseId);

  const path = `cases/${caseId}/${sha256Hex(input.file.bytes)}.${EXT[mime]}`;
  let stored: { error: unknown };
  try {
    stored = await deps.storage
      .from(CASE_FILES_BUCKET)
      .upload(path, input.file.bytes, { contentType: mime, upsert: false });
  } catch {
    throw new CaseFilesStoreError('storage.upload', null);
  }
  // Content-addressed: an object already at this path holds these bytes.
  if (stored.error && !isAlreadyExists(stored.error))
    throw new CaseFilesStoreError('storage.upload', null);

  const recorded = await recordCustomerDocumentInternal(admin, {
    source: 'staff_upload',
    accountId: input.accountId,
    contactId: input.contactId,
    kind: mime === 'application/pdf' ? 'document' : 'image',
    storageBucket: CASE_FILES_BUCKET,
    storagePath: path,
    receivedAt: clock().toISOString(),
    mime,
    originalName: sanitizeOriginalName(input.file.originalName),
    uploadedBy: actor,
    caseId,
  });
  if (!recorded)
    throw new CaseFilesStoreError('customer_documents_record_internal', null);

  const fileId = await store.register(actor, caseId, recorded.documentId);
  if (input.docKey) {
    await classifyAndCheck({
      admin,
      actor,
      fileId,
      docKey: input.docKey,
      expiresOn: input.expiresOn,
      today: today(clock),
      deps,
    });
  }
  return loadFile(store, fileId);
}
