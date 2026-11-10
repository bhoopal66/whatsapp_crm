// ============================================================
// GET /api/v1/submission-groups/{submission_id}/case-file — the case's
// assembled case file (scope: submission_groups:read, migration 184).
//
// `{ data: { ready, documents: [{ docKey, required, status }], build:
// { version, merged, sha256, builtAt, manifest: [...] } | null } }`,
// exactly as case_file_status_api returns it. Account-scoped: an unknown
// submission, one of another workspace, or one with no case → 404
// `not_found`. Read-only.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok } from '@/lib/api/v1/respond';
import { CaseFilesStore } from '@/lib/case-files/store';
import { caseFileV1ErrorResponse } from '@/lib/case-files/v1';

type Params = { params: Promise<{ submissionId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:read');
    const { submissionId } = await params;
    // ctx.supabase is the service-role client (requireApiKey).
    const status = await new CaseFilesStore(ctx.supabase).statusForSubmission(
      ctx.accountId,
      submissionId.trim()
    );
    return ok(status);
  } catch (err) {
    return caseFileV1ErrorResponse(err, 'case-file status');
  }
}
