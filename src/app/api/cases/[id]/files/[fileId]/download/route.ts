// ============================================================
// /api/cases/[id]/files/[fileId]/download — an audited link to one case
// file's document (migration 182).
//
//   GET case readers -> 200 `{ url, expiresAt }`: a 'case-files' object
//       is signed for 600 s (expiresAt ISO); a public chat-media object is
//       returned on the public origin (expiresAt null). A file of another
//       case, or a document at any other location, is 404 FILE_NOT_FOUND.
//       501 NOT_CONFIGURED when this install cannot sign.
//
// Order: the file belongs to the case -> the audit row
// (case_file_download_record) -> the URL -> mark it issued, only when a
// URL was produced. Every response is `Cache-Control: no-store`.
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { documentDownloadUrl, signerOf } from '@/lib/case-files/download';
import {
  caseFilesErrorResponse,
  noStore,
  notConfiguredResponse,
  refused,
  requireFileId,
} from '@/lib/case-files/http';
import { CaseFilesStore } from '@/lib/case-files/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string; fileId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id, fileId: rawFileId } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const fileId = requireFileId(rawFileId);
    const admin = supabaseAdmin();
    const signer = signerOf(admin?.storage);
    if (!signer) return noStore(notConfiguredResponse());

    const store = new CaseFilesStore(admin);
    const file = await store.getFile(fileId);
    if (!file || file.caseId !== c.id) throw refused('FILE_NOT_FOUND');

    const now = new Date();
    const rec = await store.recordFileDownload(ctx.userId, fileId, now);
    const doc = await store.getDocument(rec.customerDocumentId);
    const link = doc ? await documentDownloadUrl(doc, signer, now) : null;
    if (!link) throw refused('FILE_NOT_FOUND');
    await store.markDownloadIssued(rec.downloadId);
    return noStore(
      NextResponse.json({ url: link.url, expiresAt: link.expiresAt })
    );
  } catch (err) {
    return noStore(caseFilesErrorResponse(err, 'file download'));
  }
}
