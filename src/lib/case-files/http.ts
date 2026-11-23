/**
 * Request / response helpers for the case document file routes
 * (`/api/cases/[id]/files/*`, migration 181): the refusal -> HTTP table,
 * the body and form parsing, and the error response.
 *
 * TENANCY: as lib/cases/http.ts. A route loads the case through
 * `loadCaseForCaller` (the case's account against the caller's ACTIVE
 * account, then the live role) before any service-role call here.
 *
 * Refusals answer `{ error, code }` like the other case routes; store
 * failures and anything unknown answer 500 through `caseErrorResponse`,
 * logged by function and SQLSTATE only, never database text.
 */
import { NextResponse } from 'next/server';

import {
  badRequest,
  CaseHttpError,
  caseErrorResponse,
  isUuid,
} from '@/lib/cases/http';
import { CustomerDocumentRecordError } from '@/lib/customer-docs/record';

import { isRealDate } from './checks';
import {
  CaseFilesRefusedError,
  CaseFilesStoreError,
  type CaseFileSpecInput,
  type CaseFilesRefusal,
  type CaseFilesSwitch,
} from './store';

/** Above this Content-Length an upload is refused before its body is read. */
export const MAX_UPLOAD_REQUEST_BYTES = 15 * 1024 * 1024;

const FILE_TOO_LARGE_TEXT = 'The file is too large (max 10 MB)';
const VALIDATION_TEXT = 'That request is not valid';

/** Every refusal the case-files layer raises, as status and wording. */
export const CASE_FILES_REFUSAL_HTTP: Readonly<
  Record<CaseFilesRefusal, { status: number; text: string }>
> = {
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  CASE_NOT_FOUND: { status: 404, text: 'Case not found' },
  FILE_NOT_FOUND: { status: 404, text: 'File not found' },
  CASE_CLOSED: { status: 409, text: 'The case is closed' },
  CHECK_MISMATCH: {
    status: 409,
    text: 'The file was classified again; reload and try once more',
  },
  FILE_STATE: { status: 409, text: 'The file cannot be changed now' },
  NO_CONTACT: { status: 409, text: 'The case has no customer contact' },
  FILE_NOT_READY: {
    status: 409,
    text: 'Every required document needs a passed file first',
  },
  BUILD_INVALID: {
    status: 409,
    text: 'The case files changed while building; try again',
  },
  BUILD_STALE: { status: 409, text: 'The case file is out of date' },
  BUILD_TOO_LARGE: {
    status: 422,
    text: 'The case file would be too large to store',
  },
  DOC_NOT_REQUIRED: {
    status: 422,
    text: 'That document is not on this case’s list',
  },
  SPEC_INVALID: { status: 422, text: 'That file spec is not valid' },
  DOCS_INVALID: { status: 422, text: 'That document list is not valid' },
  CHECKS_INVALID: { status: 422, text: 'Those check results are not valid' },
  FILE_INVALID: { status: 422, text: 'That file cannot be used here' },
  BANK_UNKNOWN: {
    status: 422,
    text: 'That bank is not set up in this workspace',
  },
  SETTING_INVALID: { status: 422, text: 'That setting is not valid' },
  VALIDATION_FAILED: { status: 422, text: VALIDATION_TEXT },
  MIME_NOT_ALLOWED: {
    status: 422,
    text: 'Upload a PDF, JPEG or PNG file',
  },
  FILE_TOO_LARGE: { status: 413, text: FILE_TOO_LARGE_TEXT },
  STORAGE_UNAVAILABLE: {
    status: 503,
    text: 'The file store did not answer. Try again in a moment',
  },
};

/**
 * `customer_documents_record_internal` (180) refusals met while recording
 * an upload. INVALID is a bad argument; NOT_FOUND means the case's
 * contact or the uploader no longer qualifies (changed since the case
 * was loaded), so it is a conflict, not "case not found".
 */
const RECORD_REFUSAL_HTTP: Readonly<
  Record<string, { status: number; code: string; text: string }>
> = {
  INVALID: {
    status: 422,
    code: 'DOCUMENT_INVALID',
    text: 'The file could not be recorded',
  },
  NOT_FOUND: {
    status: 409,
    code: 'DOCUMENT_NOT_RECORDED',
    text: 'The file could not be recorded for this customer',
  },
};

export function refusalResponse(code: CaseFilesRefusal): NextResponse {
  const { status, text } = CASE_FILES_REFUSAL_HTTP[code];
  return NextResponse.json({ error: text, code }, { status });
}

/** Any error a case-files route can meet, as a response. */
export function caseFilesErrorResponse(
  err: unknown,
  route: string
): NextResponse {
  if (err instanceof CaseFilesRefusedError) return refusalResponse(err.reason);
  if (err instanceof CustomerDocumentRecordError) {
    const r = err.hint ? RECORD_REFUSAL_HTTP[err.hint] : undefined;
    if (r)
      return NextResponse.json(
        { error: r.text, code: r.code },
        { status: r.status }
      );
    console.error(`[cases] ${route} record failure:`, err.code);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
  if (err instanceof CaseFilesStoreError) {
    console.error(`[cases] ${route} store failure:`, err.fn, err.code);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
  return caseErrorResponse(err, route);
}

/** A refusal to throw from a route: caught and answered as `{ error, code }`. */
export function refused(code: CaseFilesRefusal): CaseHttpError {
  const { status, text } = CASE_FILES_REFUSAL_HTTP[code];
  return new CaseHttpError(status, text, { code });
}

/** A declared Content-Length above MAX_UPLOAD_REQUEST_BYTES. */
export function declaredTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d{1,16}$/.test(raw.trim())) return false;
  return Number(raw.trim()) > MAX_UPLOAD_REQUEST_BYTES;
}

/** The file id from the path, or 404 FILE_NOT_FOUND. */
export function requireFileId(value: unknown): string {
  if (!isUuid(value)) throw refused('FILE_NOT_FOUND');
  return value;
}

/** Not blank, at most 64 characters, passed on unchanged (181 decides). */
function docKeyOf(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw refused('VALIDATION_FAILED');
    return null;
  }
  if (typeof value !== 'string' || /^\s*$/.test(value) || value.length > 64)
    throw refused('VALIDATION_FAILED');
  return value;
}

/** Absent / null / '' -> null; else a real YYYY-MM-DD date, or 422. */
function expiresOnOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isRealDate(value))
    throw refused('VALIDATION_FAILED');
  return value;
}

/** POST files/attach: `{ customerDocumentId, docKey, expiresOn? }`. */
export function parseAttachBody(body: Record<string, unknown>): {
  customerDocumentId: string;
  docKey: string;
  expiresOn: string | null;
} {
  if (!isUuid(body.customerDocumentId)) throw refused('VALIDATION_FAILED');
  return {
    customerDocumentId: body.customerDocumentId,
    docKey: docKeyOf(body.docKey, true)!,
    expiresOn: expiresOnOf(body.expiresOn),
  };
}

/** POST files/[fileId]/classify: `{ docKey, expiresOn? }`. */
export function parseClassifyBody(body: Record<string, unknown>): {
  docKey: string;
  expiresOn: string | null;
} {
  return {
    docKey: docKeyOf(body.docKey, true)!,
    expiresOn: expiresOnOf(body.expiresOn),
  };
}

/**
 * POST files: the multipart form. No form or no `file` part is a 400;
 * a bad `docKey` / `expiresOn` is 422 VALIDATION_FAILED. The size is the
 * route's to check.
 */
export function parseUploadForm(form: FormData | null): {
  file: File;
  docKey: string | null;
  expiresOn: string | null;
} {
  const file = form?.get('file');
  if (!(file instanceof File)) throw new CaseHttpError(400, 'file is required');
  return {
    file,
    docKey: docKeyOf(form!.get('docKey'), false),
    expiresOn: expiresOnOf(form!.get('expiresOn')),
  };
}

/** Marks a response `Cache-Control: no-store` (download and build routes). */
export function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** 501: this install cannot sign download URLs. */
export function notConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Downloads are not configured', code: 'NOT_CONFIGURED' },
    { status: 501 }
  );
}

/** 181's allowed_mime universe. */
export const SPEC_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
];

/** case_file_spec_rows' name pattern when no spec is stored. */
export const DEFAULT_NAME_PATTERN = '{{case}}_{{doc}}_{{yyyymmdd}}';

const SPEC_ROW_KEYS = new Set([
  'docKey',
  'position',
  'namePattern',
  'required',
  'maxMb',
  'allowedMime',
  'minValidDays',
  'merged',
]);

const isIntIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Not blank, at most 200 characters, only 181's four placeholders. */
function isNamePattern(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    !/^\s*$/.test(v) &&
    [...v].length <= 200 &&
    !/\{\{|\}\}/.test(v.replace(/\{\{(case|company|doc|yyyymmdd)\}\}/g, ''))
  );
}

function specRowOf(value: unknown): CaseFileSpecInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw refused('SPEC_INVALID');
  const r = value as Record<string, unknown>;
  const namePattern = r.namePattern ?? DEFAULT_NAME_PATTERN;
  const minValidDays = r.minValidDays ?? null;
  const mime = r.allowedMime;
  if (
    Object.keys(r).some((k) => !SPEC_ROW_KEYS.has(k)) ||
    typeof r.docKey !== 'string' ||
    !/^[a-z0-9_]{1,64}$/.test(r.docKey) ||
    !isIntIn(r.position, 1, 999_999_999) ||
    !isNamePattern(namePattern) ||
    typeof r.required !== 'boolean' ||
    !isIntIn(r.maxMb, 1, 100) ||
    !Array.isArray(mime) ||
    mime.length === 0 ||
    mime.some((m) => typeof m !== 'string' || !SPEC_MIME_TYPES.includes(m)) ||
    (minValidDays !== null && !isIntIn(minValidDays, 0, 3650)) ||
    typeof r.merged !== 'boolean'
  )
    throw refused('SPEC_INVALID');
  return {
    doc_key: r.docKey,
    name_pattern: namePattern,
    position: r.position,
    required: r.required,
    max_mb: r.maxMb,
    allowed_mime: mime as string[],
    min_valid_days: minValidDays as number | null,
    merged: r.merged,
  };
}

/**
 * PUT file-specs `rows`: the whole spec of one bank + product, checked
 * here against every rule of case_file_spec_set (181) that a malformed
 * value could otherwise turn into a cast error (22P02, a 500) instead of
 * SPEC_INVALID. An empty array is valid: it removes the spec. Absent or
 * null `namePattern` is the default pattern; absent or null
 * `minValidDays` is no minimum.
 */
export function parseSpecRows(value: unknown): CaseFileSpecInput[] {
  if (!Array.isArray(value)) throw refused('SPEC_INVALID');
  const rows = value.map(specRowOf);
  const distinct = (pick: (r: CaseFileSpecInput) => unknown) =>
    new Set(rows.map(pick)).size;
  if (
    distinct((r) => r.doc_key) !== rows.length ||
    distinct((r) => r.position) !== rows.length ||
    distinct((r) => r.merged) > 1
  )
    throw refused('SPEC_INVALID');
  return rows;
}

/** What PUT /api/cases/config/settings may change of the file settings. */
export interface CaseFilesSettingsChange {
  switches: [CaseFilesSwitch, boolean][];
  stages: { from: string | null; to: string | null } | null;
}

const FILE_SWITCHES: Readonly<Record<string, CaseFilesSwitch>> = {
  checklistSync: 'files_checklist_sync',
  readyMove: 'files_ready_move',
  intakePrompts: 'files_intake_prompts',
};

function stageOf(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || /^\s*$/.test(value) || value.length > 200)
    throw badRequest(`caseFiles.${field} must be a stage name or null`);
  return value;
}

/**
 * The settings PUT's `caseFiles` object (the GET's shape): absent -> null;
 * each switch a boolean; `readyFromStage` and `readyToStage` sent together
 * (each a stage name or null; both null clears). Only the keys sent are
 * changed. Anything else is a 400; the stage rules are 181's to judge.
 */
export function parseCaseFilesSettings(
  value: unknown
): CaseFilesSettingsChange | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('caseFiles must be an object');
  const body = value as Record<string, unknown>;
  const switches: [CaseFilesSwitch, boolean][] = [];
  for (const key of Object.keys(body)) {
    if (key === 'readyFromStage' || key === 'readyToStage') continue;
    const which = FILE_SWITCHES[key];
    if (!which) throw badRequest(`caseFiles.${key} is not a setting`);
    if (typeof body[key] !== 'boolean')
      throw badRequest(`caseFiles.${key} must be true or false`);
    switches.push([which, body[key]]);
  }
  const hasFrom = 'readyFromStage' in body;
  if (hasFrom !== 'readyToStage' in body)
    throw badRequest('caseFiles.readyFromStage and readyToStage go together');
  const stages = hasFrom
    ? {
        from: stageOf(body.readyFromStage, 'readyFromStage'),
        to: stageOf(body.readyToStage, 'readyToStage'),
      }
    : null;
  if (switches.length === 0 && !stages) return null;
  return { switches, stages };
}
