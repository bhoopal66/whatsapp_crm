// ============================================================
// GET /api/cases/mentions?limit=&after= — the case notes that mention
// the caller (migration 185), on cases they may read now, in their ACTIVE
// workspace; newest first.
//
// -> `{ items: [{ noteId, caseId, stage, authorId, systemAuthor,
// createdAt, body }], next }`. `next` (opaque) is NULL on the last page;
// pass it back as `after`. The first page runs at the server clock, a
// later one at its cursor's own clock. 422 LIMIT_INVALID (limit 1..200)
// / CURSOR_INVALID.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { caseErrorResponse } from '@/lib/cases/http';
import { caseViews } from '@/lib/cases/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const params = new URL(request.url).searchParams;
    const limitText = params.get('limit') || null;
    const after = params.get('after') || null;
    // A non-integer limit becomes NaN, which the lib refuses (LIMIT_INVALID).
    const limit =
      limitText === null
        ? undefined
        : /^\d{1,9}$/.test(limitText)
          ? Number(limitText)
          : NaN;
    const page = await caseViews().mentions(ctx.userId, { limit, after });
    return NextResponse.json(page);
  } catch (err) {
    return caseErrorResponse(err, 'mentions GET');
  }
}
