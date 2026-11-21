// ============================================================
// /api/submission-groups/[id]/access — the group's staff access list
// (115). Admin only. PUT `{ user_id, label }` adds or relabels a person;
// DELETE `?user_id=` closes their row. Only while the group is ACTIVE
// (the RPCs raise 55000 otherwise); the access trigger refuses anyone
// who is not live staff of the group's workspace. Once the row is
// written, the person's saved WhatsApp number (219) is added to or taken
// out of the WhatsApp group; the answer's `number` says how that went.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertSalesAccess,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  accessErrorFor,
  isUuid,
  ownGroup,
  parseAccessRemove,
  parseAccessSet,
} from '@/lib/submission-groups/http';
import {
  linkStaffNumber,
  submissionGroupStore,
  unlinkStaffNumber,
} from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

function errorResponse(err: unknown) {
  const mapped = accessErrorFor(err);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  return toErrorResponse(err);
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const { id } = await params;
    const store = submissionGroupStore();
    const group = ownGroup(
      isUuid(id) ? await store.get(id) : null,
      ctx.accountId
    );
    const { userId, label } = parseAccessSet(
      await request.json().catch(() => null)
    );
    await store.accessSet(group.id, userId, label, ctx.userId);
    // Their saved WhatsApp number follows the access (never throws, and
    // never changes the access outcome above).
    const number = await linkStaffNumber(group, userId);
    return NextResponse.json({ ok: true, number });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const { id } = await params;
    const store = submissionGroupStore();
    const group = ownGroup(
      isUuid(id) ? await store.get(id) : null,
      ctx.accountId
    );
    const { userId } = parseAccessRemove(new URL(request.url).searchParams);
    const removed = await store.accessRemove(group.id, userId);
    // Only a row that was really closed takes the number out: access that
    // comes from a rule (163 bank holder, 173 team leader) is unchanged by
    // this DELETE, so their number must stay in the group too.
    const number = removed
      ? await unlinkStaffNumber(group, userId)
      : { status: 'none' as const, reason: 'no_access_row' };
    return NextResponse.json({ removed, number });
  } catch (err) {
    return errorResponse(err);
  }
}
