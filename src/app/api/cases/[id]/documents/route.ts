// ============================================================
// /api/cases/[id]/documents — the case's document checklist (018c,
// migration 123). GET (any case role): `{ items, missing }`, each item
// `{ docKey, label, position, status, fileRef, updatedBy, updatedAt,
// missing }` (missing = not received). POST (case writers)
// `{ doc_key, status: 'requested' | 'received' | 'rejected', file_ref? }`
// -> 200 `{ status }`; 'received' needs a file_ref (FILE_REF_REQUIRED),
// a document the case does not require is DOC_NOT_REQUIRED (both 422).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  caseErrorResponse,
  loadCaseForCaller,
  oneOf,
  optionalFileRef,
  readObject,
  requiredKey,
} from '@/lib/cases/http';
import { caseStore, caseToolsStore } from '@/lib/cases/server';
import type { DocStatus } from '@/lib/cases/tools';

type Params = { params: Promise<{ id: string }> };

const STATUSES: readonly DocStatus[] = ['requested', 'received', 'rejected'];

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: false,
      }
    );
    const { items, missing } = await caseToolsStore().checklist(c.id);
    return NextResponse.json({
      items: items.map((i) => ({ ...i, missing: i.status !== 'received' })),
      missing,
    });
  } catch (err) {
    return caseErrorResponse(err, 'documents GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: true,
      }
    );
    const body = await readObject(request);
    const docKey = requiredKey(body.doc_key, 'doc_key');
    const status = oneOf(body.status, STATUSES, 'status');
    const fileRef = optionalFileRef(body.file_ref);

    const saved = await caseToolsStore().setDocStatus({
      caseId: c.id,
      actor: ctx.userId,
      docKey,
      status,
      fileRef,
    });
    return NextResponse.json({ status: saved });
  } catch (err) {
    return caseErrorResponse(err, 'documents POST');
  }
}
