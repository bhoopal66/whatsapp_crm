// ============================================================
// DELETE /api/cases/macros/[id] — delete a case macro (186): the owner,
// or an owner/admin of the workspace for any of its macros.
// → `{ deleted: true }`; 404 MACRO_NOT_FOUND; 403 NOT_ALLOWED.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse, CaseHttpError, isUuid } from '@/lib/cases/http';
import { caseMacroStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id))
      throw new CaseHttpError(404, 'Macro not found', {
        code: 'MACRO_NOT_FOUND',
      });
    await caseMacroStore().delete(ctx.userId, id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return caseErrorResponse(err, 'macro delete');
  }
}
