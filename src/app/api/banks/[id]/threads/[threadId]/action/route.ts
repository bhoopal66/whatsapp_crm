// ============================================================
// /api/banks/[id]/threads/[threadId]/action — mark a thread "Action
// needed" (018c, 126). One per thread; on a case-linked thread Postgres
// also creates the case task. The thread must be one of the workspace's
// (else 404).
// POST `{ owner_id, due_at }` (a uuid; an ISO timestamp) -> 201
// `{ actionId }`. A missing due date is DUE_REQUIRED, an unparseable one
// DUE_INVALID (422).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankThread } from '@/lib/cases/bank-http';
import { badRequest, isUuid, readJsonObject } from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string; threadId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, threadId } = await params;
    const store = bankWorkspaceStore();
    const { thread } = await loadBankThread(store, ctx, id, threadId);
    const input = await readJsonObject(request);
    if (!input) throw badRequest('Body must be a JSON object');
    if (!isUuid(input.owner_id)) throw badRequest('owner_id must be a uuid');
    const due = input.due_at;
    if (due !== undefined && due !== null && typeof due !== 'string')
      throw badRequest('due_at must be an ISO timestamp');

    const actionId = await store.markAction({
      threadId: thread.threadId,
      actor: ctx.userId,
      ownerId: input.owner_id,
      dueAt: typeof due === 'string' && due !== '' ? new Date(due) : null,
    });
    return NextResponse.json({ actionId }, { status: 201 });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
