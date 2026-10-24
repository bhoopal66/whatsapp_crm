// ============================================================
// /api/submission-groups/[id]/retry — an admin finishes a pending
// WhatsApp group create now (115). `pending` stays true while the group
// is ACTIVE with no WhatsApp group yet (another worker holds the create
// claim, or the create failed again). A consent refusal is 409.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid, ownGroup, SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';
import { isPendingCreate } from '@/lib/submission-groups/views';

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
    const out = await submissionGroupService(ctx.accountId).retryOne(group.id);
    if (out.consentRequired)
      throw new SgHttpError(
        409,
        "The customer can't be contacted, so the group was not created"
      );
    return NextResponse.json({
      group: out.group,
      pending: isPendingCreate(out.group),
    });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
