// ============================================================
// /api/submission-groups/[id]/invite — a person sends the customer the
// group's invite link again, 1:1 from the hosting number. An owner/admin
// or anyone with an open label on the group. The service decides whether
// the send may happen; this route words the answer.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertSalesAccess,
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import { isUuid, ownGroup, SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';
import type { ResendInviteRefusal } from '@/lib/submission-groups/service';
import { canManageSubmissionGroups } from '@/lib/submission-groups/views';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const REFUSALS: Record<
  ResendInviteRefusal,
  { status: number; message: string }
> = {
  not_active: { status: 409, message: 'This group has ended' },
  no_whatsapp: { status: 409, message: 'This case has no WhatsApp group' },
  no_group_yet: {
    status: 409,
    message: 'The WhatsApp group has not been created yet',
  },
  detached: {
    status: 409,
    message: 'The WhatsApp number or the contact was removed',
  },
  opted_out: {
    status: 409,
    message: 'The customer has opted out, so no invite was sent',
  },
  do_not_contact: {
    status: 409,
    message: 'The customer is marked do not contact, so no invite was sent',
  },
  no_phone: { status: 409, message: 'The customer has no phone number' },
  already_joined: {
    status: 409,
    message: 'The customer is already in the group',
  },
  too_soon: {
    status: 429,
    message:
      'An invite was sent, or tried, in the last 10 minutes. Try again later',
  },
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const store = submissionGroupStore();
    const group = ownGroup(
      isUuid(id) ? await store.get(id) : null,
      ctx.accountId
    );
    if (
      !canManageSubmissionGroups(ctx.role) &&
      !(await store.openAccessLabel(group.id, ctx.userId))
    )
      throw new SgHttpError(403, 'You are not on this group');

    const out = await submissionGroupService(ctx.accountId).resendInvite(
      group.id
    );
    if (out.status === 'refused') {
      const refusal = REFUSALS[out.code];
      throw new SgHttpError(refusal.status, refusal.message);
    }
    if (out.status === 'failed') throw new SgHttpError(502, out.reason);
    return NextResponse.json({ group: out.group });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
