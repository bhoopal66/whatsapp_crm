// ============================================================
// /api/submission-groups/[id]/access — the group's staff access list
// (115). Admin only. PUT `{ user_id, label }` adds or relabels a person;
// DELETE `?user_id=` closes their row. Only while the group is ACTIVE
// (the RPCs raise 55000 otherwise); the access trigger refuses anyone
// who is not live staff of the group's workspace.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  accessErrorFor,
  isUuid,
  ownGroup,
  parseAccessRemove,
  parseAccessSet,
} from '@/lib/submission-groups/http';
import { submissionGroupStore } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

function errorResponse(err: unknown) {
  const mapped = accessErrorFor(err);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  return toErrorResponse(err);
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const store = submissionGroupStore();
    const group = ownGroup(
      isUuid(id) ? await store.get(id) : null,
      ctx.accountId
    );
    const { userId } = parseAccessRemove(new URL(request.url).searchParams);
    const removed = await store.accessRemove(group.id, userId);
    return NextResponse.json({ removed });
  } catch (err) {
    return errorResponse(err);
  }
}
