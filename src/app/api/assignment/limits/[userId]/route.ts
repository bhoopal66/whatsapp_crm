// ============================================================
// /api/assignment/limits/[userId] — one person's own chat limit
// (migration 236). Owner / admin only, the caller's active workspace.
//
// PUT { maxOpen: 1-500 } -> { ok: true }   sets or replaces it
// DELETE                 -> { ok: true }   removes it (the default
//                                            applies again)
// Both go through assignment_chat_limit_set on the caller's RLS client,
// which re-checks owner/admin and that the person is staff here.
// Refusals: 422 bad_limit, 404 no_such_member, 403 not_allowed,
// 503 not_available.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { setChatLimit } from '@/lib/assignment/rotation';
import { assignmentErrorOf, isUuid, parseChatLimit } from '@/lib/assignment/ui';

type Params = { params: Promise<{ userId: string }> };

async function write(userId: string, maxOpen: number | null) {
  const ctx = await requireRole('admin');
  if (!isUuid(userId)) {
    return NextResponse.json({ error: 'no_such_member' }, { status: 404 });
  }
  const result = await setChatLimit(ctx.supabase, userId, maxOpen);
  if (result.ok) return NextResponse.json({ ok: true });
  const known = assignmentErrorOf(result.code);
  if (known) {
    return NextResponse.json({ error: known.error }, { status: known.status });
  }
  console.error('[assignment] chat limit save failed:', result.error);
  return NextResponse.json({ error: 'save_failed' }, { status: 500 });
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { userId } = await params;
    const body = (await request.json().catch(() => null)) as {
      maxOpen?: unknown;
    } | null;
    const limit =
      body && typeof body === 'object' && typeof body.maxOpen === 'number'
        ? parseChatLimit(body.maxOpen)
        : null;
    if (limit === null) {
      await requireRole('admin');
      return NextResponse.json({ error: 'bad_limit' }, { status: 422 });
    }
    return await write(userId, limit);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { userId } = await params;
    return await write(userId, null);
  } catch (err) {
    return toErrorResponse(err);
  }
}
