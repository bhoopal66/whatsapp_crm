// ============================================================
// /api/submission-groups/[id]/end — an admin ends a group now (115).
// Ends it if still ACTIVE, then closes the WhatsApp group (or defers the
// close while a send is pending); answers the service's EndResult.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid, ownGroup, SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const group = ownGroup(
      isUuid(id) ? await submissionGroupStore().get(id) : null,
      ctx.accountId
    );
    const result = await submissionGroupService(ctx.accountId).endNow(
      group.id,
      'MANUAL'
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
