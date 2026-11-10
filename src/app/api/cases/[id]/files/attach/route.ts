// ============================================================
// /api/cases/[id]/files/attach — POST: put a document the customer
// already sent onto the case as a file, classified and checked
// (migration 181).
//
//   body `{ customerDocumentId: uuid, docKey: string, expiresOn?: 'YYYY-MM-DD' }`
//   201 `{ file }` (CaseFile); refusals `{ error, code }`
//   (lib/case-files/http.ts). 181 decides who may attach and whether the
//   document fits the case.
//
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller, readObject } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { caseFilesErrorResponse, parseAttachBody } from '@/lib/case-files/http';
import { attachCustomerDocument } from '@/lib/case-files/intake-file';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const { customerDocumentId, docKey, expiresOn } = parseAttachBody(
      await readObject(request)
    );
    const admin = supabaseAdmin();
    const file = await attachCustomerDocument({
      admin,
      actor: ctx.userId,
      caseId: c.id,
      customerDocumentId,
      docKey,
      expiresOn,
      deps: { storage: admin.storage },
    });
    return NextResponse.json({ file }, { status: 201 });
  } catch (err) {
    return caseFilesErrorResponse(err, 'files attach');
  }
}
