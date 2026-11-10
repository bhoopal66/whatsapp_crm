// ============================================================
// GET /api/v1/submission-groups/{submission_id}/case-file/download — an
// audited link to the case's current build (scope:
// submission_groups:read, migration 184).
//
// `{ data: { url, expiresAt, sha256, version } }`: a signed 'case-files'
// URL valid 600 s, on the public origin. 404 `not_found` for an unknown
// submission (or one of another workspace, or with no case); 409
// `case_file_stale` with no current build; 501 `not_configured` when
// this install cannot sign.
//
// Order (the audit contract, as /api/cases/[id]/build/download): the
// audit row with this key's id (case_build_download_record_api) -> sign
// -> mark it issued. A signer failure is 500 and leaves the row
// url_issued false. Every response is `Cache-Control: no-store`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok } from '@/lib/api/v1/respond';
import { signCaseFilesObject, signerOf } from '@/lib/case-files/download';
import { CaseFilesStore } from '@/lib/case-files/store';
import { caseFileV1ErrorResponse, noStoreV1 } from '@/lib/case-files/v1';

type Params = { params: Promise<{ submissionId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:read');
    const { submissionId } = await params;
    // ctx.supabase is the service-role client (requireApiKey).
    const signer = signerOf(ctx.supabase.storage);
    if (!signer)
      return noStoreV1(
        fail('not_configured', 'Downloads are not configured', 501)
      );

    const store = new CaseFilesStore(ctx.supabase);
    const now = new Date();
    const rec = await store.recordApiBuildDownload(
      ctx.keyId,
      ctx.accountId,
      submissionId.trim(),
      now
    );
    const { url, expiresAt } = await signCaseFilesObject(
      signer,
      rec.objectPath,
      now
    );
    await store.markDownloadIssued(rec.downloadId);
    return noStoreV1(
      ok({ url, expiresAt, sha256: rec.sha256, version: rec.version })
    );
  } catch (err) {
    return noStoreV1(caseFileV1ErrorResponse(err, 'case-file download'));
  }
}
