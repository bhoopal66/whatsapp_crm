// ============================================================
// /api/cases/[id]/build/download — an audited link to the case's ready
// build (migration 182).
//
//   GET case readers -> 200 `{ url, expiresAt, sha256, version }`: a
//       signed 'case-files' URL valid 600 s, on the public origin.
//       404 FILE_NOT_FOUND unless readable; 409 BUILD_STALE with no ready
//       build; 501 NOT_CONFIGURED when this install cannot sign.
//
// Order: the audit row (case_build_download_record) -> sign -> mark it
// issued. A signer failure is 500 and leaves the row url_issued false.
// Every response is `Cache-Control: no-store`.
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { signCaseFilesObject, signerOf } from '@/lib/case-files/download';
import {
  caseFilesErrorResponse,
  noStore,
  notConfiguredResponse,
} from '@/lib/case-files/http';
import { CaseFilesStore } from '@/lib/case-files/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const admin = supabaseAdmin();
    const signer = signerOf(admin?.storage);
    if (!signer) return noStore(notConfiguredResponse());

    const store = new CaseFilesStore(admin);
    const now = new Date();
    const rec = await store.recordBuildDownload(ctx.userId, c.id, now);
    const { url, expiresAt } = await signCaseFilesObject(
      signer,
      rec.objectPath,
      now
    );
    await store.markDownloadIssued(rec.downloadId);
    return noStore(
      NextResponse.json({
        url,
        expiresAt,
        sha256: rec.sha256,
        version: rec.version,
      })
    );
  } catch (err) {
    return noStore(caseFilesErrorResponse(err, 'build download'));
  }
}
