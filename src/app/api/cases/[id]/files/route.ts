// ============================================================
// /api/cases/[id]/files — the case's document files (migration 181).
//
//   GET  case readers -> 200 `{ files, ready, spec }`: every file, every
//        version, newest first (CaseFile, no storage path or URL); whether
//        every required document has a passed file; the file spec merged
//        with the checklist.
//   POST multipart/form-data `file` (PDF / JPEG / PNG, <= 10 MB), optional
//        `docKey`, optional `expiresOn` (YYYY-MM-DD), optional `move`
//        ('true': from another document) -> 201 `{ file }`.
//        A Content-Length above 15 MB is 413 before the body is read.
//        181 decides who may upload (403 NOT_ALLOWED).
//
// Refusals are `{ error, code }` (lib/case-files/http.ts).
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import {
  caseFilesErrorResponse,
  declaredTooLarge,
  parseUploadForm,
  refused,
} from '@/lib/case-files/http';
import {
  MAX_UPLOAD_BYTES,
  uploadStaffFile,
} from '@/lib/case-files/intake-file';
import { CaseFilesStore } from '@/lib/case-files/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const store = new CaseFilesStore(supabaseAdmin());
    const [files, ready, spec] = await Promise.all([
      store.listFiles(c.id),
      store.fileReady(c.id),
      store.specRows(c.id),
    ]);
    return NextResponse.json({ files, ready, spec });
  } catch (err) {
    return caseFilesErrorResponse(err, 'files list');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    if (declaredTooLarge(request)) throw refused('FILE_TOO_LARGE');
    if (!c.contactId) throw refused('NO_CONTACT');

    const { file, docKey, expiresOn, move } = parseUploadForm(
      await request.formData().catch(() => null)
    );
    if (file.size > MAX_UPLOAD_BYTES) throw refused('FILE_TOO_LARGE');

    const admin = supabaseAdmin();
    const created = await uploadStaffFile({
      admin,
      actor: ctx.userId,
      caseId: c.id,
      accountId: c.accountId,
      contactId: c.contactId,
      file: {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: file.type,
        originalName: file.name,
      },
      docKey,
      expiresOn,
      move,
      deps: { storage: admin.storage },
    });
    return NextResponse.json({ file: created }, { status: 201 });
  } catch (err) {
    return caseFilesErrorResponse(err, 'files upload');
  }
}
