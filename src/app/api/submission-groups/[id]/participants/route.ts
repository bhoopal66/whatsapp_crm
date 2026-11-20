// ============================================================
// /api/submission-groups/[id]/participants — a person adds another phone
// number to the group's WhatsApp group (migration 211). Anyone who can
// open the group: an owner/admin or anyone with an open label on it.
// SQL decides (access, state, consent, a limit of 10 adds a day per
// group) and logs who added which number; this route words the answer.
// When WhatsApp declines (privacy settings), the answer carries the
// group's invite link for the person to share: nothing is sent 1:1.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertSalesAccess,
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { isUuid, ownGroup, SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';
import type { AddNumberRefusal } from '@/lib/submission-groups/store';
import { canManageSubmissionGroups } from '@/lib/submission-groups/views';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const REFUSALS: Record<AddNumberRefusal, { status: number; message: string }> =
  {
    not_found: { status: 404, message: 'Group not found' },
    not_active: { status: 409, message: 'This group has ended' },
    not_allowed: { status: 403, message: 'You are not on this group' },
    no_whatsapp: { status: 409, message: 'This case has no WhatsApp group' },
    no_group_yet: {
      status: 409,
      message: 'The WhatsApp group has not been created yet',
    },
    detached: {
      status: 409,
      message: 'The WhatsApp number or the contact was removed',
    },
    bad_phone: {
      status: 400,
      message: 'Enter one number with its country code, e.g. +971 50 123 4567',
    },
    own_number: {
      status: 400,
      message: "That is the group's own WhatsApp number",
    },
    opted_out: {
      status: 409,
      message: 'This number has opted out, so it was not added',
    },
    do_not_contact: {
      status: 409,
      message: 'This number is marked do not contact, so it was not added',
    },
    in_progress: {
      status: 409,
      message: 'This number is being added already; wait a moment',
    },
    too_many: {
      status: 429,
      message: '10 numbers were added to this group in the last 24 hours',
    },
    unknown: { status: 503, message: 'Could not add the number; try again' },
  };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const raw = (await request.json().catch(() => null)) as {
      phone?: unknown;
    } | null;
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

    const checked = validateContactPhone(
      typeof raw?.phone === 'string' ? raw.phone : ''
    );
    if (!checked.ok) throw new SgHttpError(400, checked.error);
    const phone = checked.normalized.replace(/\D/g, '');

    const out = await submissionGroupService(ctx.accountId).addNumber(
      group.id,
      ctx.userId,
      phone
    );
    if (out.status === 'not_allowed') {
      const refusal = REFUSALS[out.code];
      throw new SgHttpError(refusal.status, refusal.message);
    }
    if (out.status === 'failed') throw new SgHttpError(502, out.reason);
    return NextResponse.json(
      out.status === 'added'
        ? { added: true, phone }
        : { added: false, phone, inviteLink: out.inviteLink }
    );
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
