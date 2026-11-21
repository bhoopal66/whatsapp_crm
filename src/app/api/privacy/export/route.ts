// POST /api/privacy/export — PDPL subject access: `{ contactId }` ->
// 200, the customer's data as a JSON download (migration 221). Owners and
// admins only; another workspace's or an unknown contact is 404. Each
// export is logged (privacy_requests, by hash).
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  noStore,
  privacyErrorResponse,
  readBody,
  requireContactId,
} from '@/lib/privacy/http';
import { PrivacyRefusedError, PrivacyStore } from '@/lib/privacy/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const contactId = requireContactId((await readBody(request)).contactId);
    const data = await new PrivacyStore(supabaseAdmin()).exportSubject(
      ctx.userId,
      ctx.accountId,
      contactId
    );
    if (data === null) throw new PrivacyRefusedError('NOT_FOUND');
    const res = NextResponse.json(data);
    res.headers.set(
      'Content-Disposition',
      `attachment; filename="customer-data-${contactId}.json"`
    );
    return noStore(res);
  } catch (err) {
    return privacyErrorResponse(err, 'export');
  }
}
