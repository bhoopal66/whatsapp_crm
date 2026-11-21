// /api/privacy/legal-hold — a customer legal hold (migration 222). While
// active, erase and the retention sweep leave the customer alone.
//   GET  ?contactId= -> `{ onHold, reason, placedAt }`
//   POST `{ contactId, action: 'place' | 'release', reason? }` (a reason
//        is required to place) -> the same shape.
// Owners and admins only.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  noStore,
  PrivacyBadRequest,
  privacyErrorResponse,
  readBody,
  requireContactId,
} from '@/lib/privacy/http';
import { PrivacyRefusedError, PrivacyStore } from '@/lib/privacy/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const contactId = requireContactId(
      new URL(request.url).searchParams.get('contactId')
    );
    const hold = await new PrivacyStore(supabaseAdmin()).legalHold(
      ctx.userId,
      ctx.accountId,
      contactId
    );
    if (hold === null) throw new PrivacyRefusedError('NOT_FOUND');
    return noStore(NextResponse.json(hold));
  } catch (err) {
    return privacyErrorResponse(err, 'legal hold');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readBody(request);
    const contactId = requireContactId(body.contactId);
    if (body.action !== 'place' && body.action !== 'release')
      throw new PrivacyBadRequest("action must be 'place' or 'release'");
    if (
      body.reason !== undefined &&
      body.reason !== null &&
      typeof body.reason !== 'string'
    )
      throw new PrivacyBadRequest('reason must be text');
    const hold = await new PrivacyStore(supabaseAdmin()).legalHold(
      ctx.userId,
      ctx.accountId,
      contactId,
      {
        place: body.action === 'place',
        reason: (body.reason as string | null | undefined) ?? null,
      }
    );
    if (hold === null) throw new PrivacyRefusedError('NOT_FOUND');
    return noStore(NextResponse.json(hold));
  } catch (err) {
    return privacyErrorResponse(err, 'legal hold');
  }
}
