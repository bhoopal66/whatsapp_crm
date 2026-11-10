// ============================================================
// DELETE /api/cases/views/[id] — delete a saved Cases inbox view (185).
//
// The owner, or an owner/admin of the workspace for any of its views.
// Another person's private view, or another workspace's: 404
// VIEW_NOT_FOUND; another person's shared view below admin: 403.
// -> `{ deleted: true }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse, CaseHttpError, isUuid } from '@/lib/cases/http';
import { caseViews } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id))
      throw new CaseHttpError(404, 'View not found', {
        code: 'VIEW_NOT_FOUND',
      });
    await caseViews().delete(ctx.userId, id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return caseErrorResponse(err, 'views DELETE');
  }
}
