// GET /api/desk/companies?q=<licence or name> — companies the caller may
// read (a case of theirs, or team leader and up) whose trade licence or
// legal name contains q (2+ characters): `{ companies }` (migration 229).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { deskErrorResponse, requireText } from '@/lib/desk/http';
import { DeskStore } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const q = requireText(new URL(request.url).searchParams.get('q'), 200, 'q');
    const companies = await new DeskStore(supabaseAdmin()).findCompanies(
      ctx.userId,
      ctx.accountId,
      q
    );
    return NextResponse.json({ companies });
  } catch (err) {
    return deskErrorResponse(err, 'company search');
  }
}
