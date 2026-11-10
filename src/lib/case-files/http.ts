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

import { CaseHttpError, caseErrorResponse, isUuid } from '@/lib/cases/http';
import { CustomerDocumentRecordError } from '@/lib/customer-docs/record';

import { isRealDate } from './checks';
import {
  CaseFilesRefusedError,
  CaseFilesStoreError,
  type CaseFilesRefusal,
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

/** The current date in UTC, YYYY-MM-DD (the expiry rule's "today"). */
export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}
