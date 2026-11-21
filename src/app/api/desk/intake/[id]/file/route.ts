// POST /api/desk/intake/[id]/file — a sorter files an upload onto an open
// case: `{ caseId, kind: 'pending_doc' | 'info', docKey? }` -> 200
// `{ item }`. Sorters only, within their banks (migration 220).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  DeskBadRequest,
  deskErrorResponse,
  optionalText,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const itemId = requireUuid((await params).id, 'id');
    const body = await readJson(request);
    const kind = body.kind;
    if (kind !== 'pending_doc' && kind !== 'info')
      throw new DeskBadRequest('kind must be pending_doc or info');
    const docKey = optionalText(body.docKey, 64, 'docKey');
    if (docKey !== null && !/^[a-z0-9_]{1,64}$/.test(docKey))
      throw new DeskBadRequest('docKey is not valid');
    const item = await new DeskStore(supabaseAdmin()).file(
      ctx.userId,
      ctx.accountId,
      itemId,
      { caseId: requireUuid(body.caseId, 'caseId'), kind, docKey }
    );
    return NextResponse.json({ item });
  } catch (err) {
    return deskErrorResponse(err, 'intake file');
  }
}
