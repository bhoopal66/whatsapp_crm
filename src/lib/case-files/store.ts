/**
 * Case document files (migration 181) over a service-role supabase-js
 * client: one typed wrapper per SECURITY DEFINER RPC, plus the plain
 * service-role reads the intake needs. The reads decide nothing about
 * access.
 *
 * TENANCY (as lib/cases/store.ts): the 181 functions resolve the actor's
 * case role live and ignore which workspace is active, so a route checks
 * the case's account against the caller's active account first, and only
 * then calls a method that takes an actor.
 *
 * Refusals (an `error.hint` in CASE_FILES_REFUSALS) throw
 * CaseFilesRefusedError; any other database error throws
 * CaseFilesStoreError carrying only the function name and SQLSTATE (the
 * SQLSTATE is what `retryOnConflict` keys on), never the database text.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Check } from './checks';

/** The HINTs migration 181 raises with. */
export const CASE_FILES_REFUSALS = [
  'NOT_ALLOWED',
  'SPEC_INVALID',
  'DOCS_INVALID',
  'BANK_UNKNOWN',
  'CASE_NOT_FOUND',
  'CASE_CLOSED',
  'NO_CONTACT',
  'FILE_NOT_FOUND',
  'FILE_INVALID',
  'FILE_STATE',
  'DOC_NOT_REQUIRED',
  'CHECKS_INVALID',
  'CHECK_MISMATCH',
  'SETTING_INVALID',
  // Migration 182 (case file builds).
  'FILE_NOT_READY',
  'BUILD_INVALID',
  'BUILD_STALE',
] as const;

/** Refused in TypeScript before anything is written (intake-file.ts). */
export type CaseFilesIntakeRefusal =
  'MIME_NOT_ALLOWED' | 'FILE_TOO_LARGE' | 'VALIDATION_FAILED';

export type CaseFilesRefusal =
  (typeof CASE_FILES_REFUSALS)[number] | CaseFilesIntakeRefusal;

export class CaseFilesRefusedError extends Error {
  override readonly name = 'CaseFilesRefusedError';
  constructor(readonly reason: CaseFilesRefusal) {
    super(`case files refused: ${reason}`);
  }
}

/** A failed RPC, read or storage call that is not a refusal; no database text. */
export class CaseFilesStoreError extends Error {
  override readonly name = 'CaseFilesStoreError';
  constructor(
    readonly fn: string,
    readonly code: string | null
  ) {
    super(`case files: ${fn} failed`);
  }
}

const REFUSALS = new Set<string>(CASE_FILES_REFUSALS);

type Row = Record<string, unknown>;
type DbError = { message?: string; code?: string; hint?: string | null };

function fail(fn: string, error: DbError): never {
  if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
    throw new CaseFilesRefusedError(error.hint as CaseFilesRefusal);
  throw new CaseFilesStoreError(fn, error.code ?? null);
}

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const rows = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];

/** The narrow client every case-files function takes. */
export type CaseFilesDb = Pick<SupabaseClient, 'rpc' | 'from'>;

export type CaseFileStatus =
  'unclassified' | 'pending_checks' | 'passed' | 'failed' | 'superseded';

/** One row of `case_file_spec_rows`: the spec, merged with the checklist. */
export interface CaseFileSpecRow {
  docKey: string;
  position: number;
  namePattern: string | null;
  required: boolean;
  maxMb: number | null;
  allowedMime: string[] | null;
  minValidDays: number | null;
  merged: boolean;
  fromSpec: boolean;
}

/** One row `case_file_spec_set` takes (absent keys take the SQL defaults). */
export interface CaseFileSpecInput {
  doc_key: string;
  name_pattern: string;
  position?: number;
  required?: boolean;
  max_mb?: number;
  allowed_mime?: string[];
  min_valid_days?: number | null;
  merged?: boolean;
}

export interface CaseFilesSettings {
  checklistSync: boolean;
  readyMove: boolean;
  readyFromStage: string | null;
  readyToStage: string | null;
  intakePrompts: boolean;
}

export type CaseFilesSwitch =
  'files_checklist_sync' | 'files_ready_move' | 'files_intake_prompts';

export interface ClassifyResult {
  classifySeq: number;
  version: number;
  renamedName: string;
}

/** The customer document a file row stands on. */
export interface CaseFileDocument {
  originalName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  source: string | null;
}

export interface CaseFile {
  id: string;
  caseId: string;
  customerDocumentId: string;
  docKey: string | null;
  version: number | null;
  status: CaseFileStatus;
  classifySeq: number;
  checks: Check[] | null;
  pages: number | null;
  expiresOn: string | null;
  renamedName: string | null;
  registeredAt: Date;
  document: CaseFileDocument | null;
}

/** The `customer_documents` columns `readDocumentBytes` reads. */
export interface CustomerDocumentRow {
  id: string;
  contactId: string;
  source: string | null;
  kind: string | null;
  mime: string | null;
  originalName: string | null;
  mediaUrl: string | null;
  storageBucket: string | null;
  storagePath: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  status: string | null;
}

/** `case_file_download_record` (182): the audit row and the document to serve. */
export interface FileDownloadRecord {
  downloadId: string;
  customerDocumentId: string;
}

/** `case_build_download_record` (182): the audit row and the ready build. */
export interface BuildDownloadRecord {
  downloadId: string;
  objectPath: string;
  sha256: string;
  version: number;
}

const FILE_COLUMNS =
  'id, case_id, customer_document_id, doc_key, version, status, classify_seq, checks, pages, expires_on, renamed_name, registered_at, customer_documents(original_name, mime, size_bytes, source)';
const DOCUMENT_COLUMNS =
  'id, contact_id, source, kind, mime, original_name, media_url, storage_bucket, storage_path, sha256, size_bytes, status';

function toFile(r: Row): CaseFile {
  const d = (
    Array.isArray(r.customer_documents)
      ? r.customer_documents[0]
      : r.customer_documents
  ) as Row | null | undefined;
  return {
    id: String(r.id),
    caseId: String(r.case_id),
    customerDocumentId: String(r.customer_document_id),
    docKey: str(r.doc_key),
    version: num(r.version),
    status: String(r.status) as CaseFileStatus,
    classifySeq: Number(r.classify_seq ?? 0),
    checks: Array.isArray(r.checks) ? (r.checks as Check[]) : null,
    pages: num(r.pages),
    expiresOn: str(r.expires_on),
    renamedName: str(r.renamed_name),
    registeredAt: new Date(String(r.registered_at)),
    document: d
      ? {
          originalName: str(d.original_name),
          mime: str(d.mime),
          sizeBytes: num(d.size_bytes),
          source: str(d.source),
        }
      : null,
  };
}

export class CaseFilesStore {
  constructor(private readonly db: CaseFilesDb) {}

  private async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) fail(fn, error);
    return data as unknown;
  }

  private async single(
    table: string,
    columns: string,
    id: string
  ): Promise<Row | null> {
    const { data, error } = await this.db
      .from(table)
      .select(columns)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new CaseFilesStoreError(table, error.code ?? null);
    return (data as Row | null) ?? null;
  }

  /** The case's file spec merged with its checklist (raises CASE_NOT_FOUND). */
  async specRows(caseId: string): Promise<CaseFileSpecRow[]> {
    const data = await this.rpc('case_file_spec_rows', { p_case: caseId });
    return rows(data).map((r) => ({
      docKey: String(r.doc_key),
      position: Number(r.position ?? 0),
      namePattern: str(r.name_pattern),
      required: r.required === true,
      maxMb: num(r.max_mb),
      allowedMime: Array.isArray(r.allowed_mime)
        ? r.allowed_mime.map(String)
        : null,
      minValidDays: num(r.min_valid_days),
      merged: r.merged === true,
      fromSpec: r.from_spec === true,
    }));
  }

  /** Replaces the (bank, product) spec; returns the audit row id. */
  async setSpec(
    actor: string,
    bankCode: string,
    product: string,
    specRows: readonly CaseFileSpecInput[]
  ): Promise<string> {
    const id = str(
      await this.rpc('case_file_spec_set', {
        p_actor: actor,
        p_bank_code: bankCode,
        p_product: product,
        p_rows: specRows,
      })
    );
    if (!id) throw new CaseFilesStoreError('case_file_spec_set', null);
    return id;
  }

  /** Throws the refusal; a plain `false` is read as NOT_ALLOWED. */
  async assertCanRegister(actor: string, caseId: string): Promise<void> {
    const ok = await this.rpc('case_document_file_can_register', {
      p_actor: actor,
      p_case: caseId,
    });
    if (ok !== true) throw new CaseFilesRefusedError('NOT_ALLOWED');
  }

  /**
   * Idempotent per (case, customer document); returns the file id.
   * A NULL actor is the system intake (WhatsApp tap-to-classify).
   */
  async register(
    actor: string | null,
    caseId: string,
    customerDocumentId: string
  ): Promise<string> {
    const id = str(
      await this.rpc('case_document_file_register', {
        p_actor: actor,
        p_case: caseId,
        p_customer_document_id: customerDocumentId,
      })
    );
    if (!id) throw new CaseFilesStoreError('case_document_file_register', null);
    return id;
  }

  /** A NULL actor is the system intake, as in `register`. */
  async classify(
    actor: string | null,
    fileId: string,
    docKey: string
  ): Promise<ClassifyResult> {
    const row = rows(
      await this.rpc('case_document_file_classify', {
        p_actor: actor,
        p_file: fileId,
        p_doc_key: docKey,
      })
    )[0];
    if (!row)
      throw new CaseFilesStoreError('case_document_file_classify', null);
    return {
      classifySeq: Number(row.classify_seq),
      version: Number(row.version),
      renamedName: String(row.renamed_name),
    };
  }

  /** Posts the checks of one classify; CHECK_MISMATCH once a newer classify ran. */
  async postCheckResult(
    fileId: string,
    docKey: string,
    classifySeq: number,
    checks: readonly Check[],
    pages: number | null,
    expiresOn: string | null
  ): Promise<'passed' | 'failed'> {
    const data = await this.rpc('case_document_file_check_result', {
      p_file: fileId,
      p_doc_key: docKey,
      p_classify_seq: classifySeq,
      p_checks: checks,
      p_pages: pages,
      p_expires_on: expiresOn,
    });
    if (data !== 'passed' && data !== 'failed')
      throw new CaseFilesStoreError('case_document_file_check_result', null);
    return data;
  }

  async fileReady(caseId: string): Promise<boolean> {
    return (await this.rpc('case_file_ready', { p_case: caseId })) === true;
  }

  async settings(accountId: string): Promise<CaseFilesSettings> {
    const r = rows(
      await this.rpc('case_files_settings', { p_account: accountId })
    )[0];
    return {
      checklistSync: r?.files_checklist_sync === true,
      readyMove: r?.files_ready_move === true,
      readyFromStage: str(r?.files_ready_from_stage),
      readyToStage: str(r?.files_ready_to_stage),
      intakePrompts: r?.files_intake_prompts === true,
    };
  }

  async setSwitch(
    actor: string,
    accountId: string,
    which: CaseFilesSwitch,
    on: boolean
  ): Promise<boolean> {
    const data = await this.rpc('case_settings_set_files_switch', {
      p_actor: actor,
      p_account: accountId,
      p_switch: which,
      p_on: on,
    });
    return data === true;
  }

  /** NULL / NULL clears the pair. */
  async setReadyStages(
    actor: string,
    accountId: string,
    fromStage: string | null,
    toStage: string | null
  ): Promise<boolean> {
    const data = await this.rpc('case_settings_set_files_ready_stages', {
      p_actor: actor,
      p_account: accountId,
      p_from: fromStage,
      p_to: toStage,
    });
    return data === true;
  }

  /**
   * Writes the audit row of one file download (url_issued false).
   * FILE_NOT_FOUND unless the actor can read the file's case.
   */
  async recordFileDownload(
    actor: string,
    fileId: string,
    now: Date
  ): Promise<FileDownloadRecord> {
    const fn = 'case_file_download_record';
    const row = rows(
      await this.rpc(fn, {
        p_actor: actor,
        p_file: fileId,
        p_now: now.toISOString(),
      })
    )[0];
    if (!row?.download_id || !row.customer_document_id)
      throw new CaseFilesStoreError(fn, null);
    return {
      downloadId: String(row.download_id),
      customerDocumentId: String(row.customer_document_id),
    };
  }

  /**
   * Writes the audit row of a build download (url_issued false).
   * FILE_NOT_FOUND unless readable; BUILD_STALE with no ready build.
   */
  async recordBuildDownload(
    actor: string,
    caseId: string,
    now: Date
  ): Promise<BuildDownloadRecord> {
    const fn = 'case_build_download_record';
    const row = rows(
      await this.rpc(fn, {
        p_actor: actor,
        p_case: caseId,
        p_now: now.toISOString(),
      })
    )[0];
    if (!row?.download_id || !row.object_path)
      throw new CaseFilesStoreError(fn, null);
    return {
      downloadId: String(row.download_id),
      objectPath: String(row.object_path),
      sha256: String(row.sha256),
      version: Number(row.version),
    };
  }

  /**
   * The case file of a submission, as migration 184 assembles it for the
   * v1 API (snake_case, passed through). FILE_NOT_FOUND for a ref unknown
   * in the account.
   */
  async statusForSubmission(
    accountId: string,
    submissionRef: string
  ): Promise<Record<string, unknown>> {
    const fn = 'case_file_status_api';
    const data = await this.rpc(fn, {
      p_account: accountId,
      p_submission_ref: submissionRef,
    });
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new CaseFilesStoreError(fn, null);
    return data as Record<string, unknown>;
  }

  /**
   * Writes the audit row of an API-key build download (migration 184,
   * url_issued false). FILE_NOT_FOUND for a ref unknown in the account or
   * a key that is not live there; BUILD_STALE with no ready build.
   */
  async recordApiBuildDownload(
    apiKeyId: string,
    accountId: string,
    submissionRef: string,
    now: Date
  ): Promise<BuildDownloadRecord> {
    const fn = 'case_build_download_record_api';
    const row = rows(
      await this.rpc(fn, {
        p_api_key: apiKeyId,
        p_account: accountId,
        p_submission_ref: submissionRef,
        p_now: now.toISOString(),
      })
    )[0];
    if (!row?.download_id || !row.object_path)
      throw new CaseFilesStoreError(fn, null);
    return {
      downloadId: String(row.download_id),
      objectPath: String(row.object_path),
      sha256: String(row.sha256),
      version: Number(row.version),
    };
  }

  /** Flips url_issued; call only once the URL was produced. */
  async markDownloadIssued(downloadId: string): Promise<void> {
    await this.rpc('case_file_download_issued', {
      p_download_id: downloadId,
    });
  }

  /** Every file of the case, every version, newest first. */
  async listFiles(caseId: string): Promise<CaseFile[]> {
    const { data, error } = await this.db
      .from('case_document_files')
      .select(FILE_COLUMNS)
      .eq('case_id', caseId)
      .order('registered_at', { ascending: false })
      .order('version', { ascending: false, nullsFirst: false });
    if (error)
      throw new CaseFilesStoreError('case_document_files', error.code ?? null);
    return rows(data).map(toFile);
  }

  async getFile(fileId: string): Promise<CaseFile | null> {
    const r = await this.single('case_document_files', FILE_COLUMNS, fileId);
    return r ? toFile(r) : null;
  }

  async getDocument(documentId: string): Promise<CustomerDocumentRow | null> {
    const r = await this.single(
      'customer_documents',
      DOCUMENT_COLUMNS,
      documentId
    );
    if (!r) return null;
    return {
      id: String(r.id),
      contactId: String(r.contact_id),
      source: str(r.source),
      kind: str(r.kind),
      mime: str(r.mime),
      originalName: str(r.original_name),
      mediaUrl: str(r.media_url),
      storageBucket: str(r.storage_bucket),
      storagePath: str(r.storage_path),
      sha256: str(r.sha256),
      sizeBytes: num(r.size_bytes),
      status: str(r.status),
    };
  }
}
