/**
 * The public API's (v1) view of case-file errors (migration 184): the
 * `/api/v1/submission-groups/{ref}/case-file*` routes answer in the v1
 * envelope, never with the dashboard's case-files wording.
 *
 *   FILE_NOT_FOUND -> 404 `not_found` (an unknown ref, a ref of another
 *                     workspace, or a key no longer live: one answer)
 *   BUILD_STALE    -> 409 `case_file_stale`
 *   anything else  -> the v1 mapping (ApiError keeps its own; else 500
 *                     `internal`, logged by function and SQLSTATE only)
 */
import type { NextResponse } from 'next/server';

import { fail, toApiErrorResponse } from '@/lib/api/v1/respond';

import { CaseFilesRefusedError, CaseFilesStoreError } from './store';

export function caseFileV1ErrorResponse(
  err: unknown,
  route: string
): NextResponse {
  if (err instanceof CaseFilesRefusedError) {
    if (err.reason === 'FILE_NOT_FOUND')
      return fail('not_found', 'Case file not found', 404);
    if (err.reason === 'BUILD_STALE')
      return fail('case_file_stale', 'The case file has no current build', 409);
  }
  if (
    err instanceof CaseFilesStoreError ||
    err instanceof CaseFilesRefusedError
  ) {
    console.error(
      `[api/v1] ${route}:`,
      err instanceof CaseFilesStoreError ? `${err.fn} ${err.code}` : err.reason
    );
    return fail('internal', 'Internal server error', 500);
  }
  return toApiErrorResponse(err);
}

/** Marks a response `Cache-Control: no-store`. */
export function noStoreV1(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
