// ============================================================
// /api/cases/[id]/files/[fileId]/classify — POST: (re)classify one of
// the case's files under a document key and run its checks
// (migration 181).
//
//   body `{ docKey: string, expiresOn?: 'YYYY-MM-DD', moveFrom?: string,
//        reuse?: boolean }`. `reuse` classifies only a replaced file; a
//        reuse or a move already done is answered as it stands.
//   200 `{ result: { fileId, status: 'passed' | 'failed', classifySeq,
//        version, renamedName, checks, pages } }`
//   404 FILE_NOT_FOUND for an unknown file and for another case's file
//   (no existence oracle). Other refusals `{ error, code }`
//   (lib/case-files/http.ts).
//
// TENANCY: loadCaseForCaller before any case-files call.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller, readObject } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import {
  caseFilesErrorResponse,
  parseClassifyBody,
  refusalResponse,
  requireFileId,
} from '@/lib/case-files/http';
import { dubaiDay } from '@/lib/case-files/day';
import { classifyAndCheck } from '@/lib/case-files/intake-file';
import { CaseFilesStore } from '@/lib/case-files/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string; fileId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id, fileId: rawFileId } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const fileId = requireFileId(rawFileId);
    const { docKey, expiresOn, moveFrom, reuse } = parseClassifyBody(
      await readObject(request)
    );

    const admin = supabaseAdmin();
    const file = await new CaseFilesStore(admin).getFile(fileId);
    if (!file || file.caseId !== c.id) return refusalResponse('FILE_NOT_FOUND');

    const result = await classifyAndCheck({
      admin,
      actor: ctx.userId,
      fileId,
      docKey,
      expiresOn,
      moveFrom,
      reuse,
      today: dubaiDay(new Date()),
      deps: { storage: admin.storage },
    });
    return NextResponse.json({ result });
  } catch (err) {
    return caseFilesErrorResponse(err, 'files classify');
  }
}
