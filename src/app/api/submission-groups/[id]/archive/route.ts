// ============================================================
// /api/submission-groups/[id]/archive — a group's message archive (115).
// POST, not GET, because every view writes an audit row. Who may read is
// decided in SQL (sg_rule_can_read via the service); a refusal is 403.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { isUuid, ownGroup, SgHttpError } from '@/lib/submission-groups/http';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = ownGroup(
      isUuid(id) ? await submissionGroupStore().get(id) : null,
      ctx.accountId
    );
    const result = await submissionGroupService(ctx.accountId).viewArchive({
      groupId: group.id,
      userId: ctx.userId,
    });
    if (!result.allowed)
      throw new SgHttpError(403, "You can't view this group's archive");
    return NextResponse.json({ messages: result.messages });
  } catch (err) {
    if (err instanceof SgHttpError)
      return NextResponse.json(err.body, { status: err.status });
    return toErrorResponse(err);
  }
}
