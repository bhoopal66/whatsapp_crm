// ============================================================
// /api/banks/[id]/threads/[threadId]/posts — a thread's posts (018c, 126).
// INTERNAL ONLY: post text never reaches a customer and is never logged.
// The thread must be one of the workspace's (else 404).
// GET -> `{ posts }` (a retracted post has `body: null`).
// POST `{ body, parent_post_id?, case_id?, task_id? }` (body 1–4000,
// trimmed; no parent: a reply to the root post) -> 201 `{ postId }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  bankErrorResponse,
  loadBankThread,
  optionalUuid,
  requiredText,
} from '@/lib/cases/bank-http';
import { BANK_WS_CAPS } from '@/lib/cases/bank-workspaces';
import { badRequest, readJsonObject } from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string; threadId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, threadId } = await params;
    const store = bankWorkspaceStore();
    const { thread } = await loadBankThread(store, ctx, id, threadId);
    return NextResponse.json({
      posts: await store.posts(thread.threadId, ctx.userId),
    });
  } catch (err) {
    return bankErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, threadId } = await params;
    const store = bankWorkspaceStore();
    const { thread } = await loadBankThread(store, ctx, id, threadId);
    const input = await readJsonObject(request);
    if (!input) throw badRequest('Body must be a JSON object');
    const body = requiredText(input.body, 'body', BANK_WS_CAPS.body);
    const parentPostId = optionalUuid(input.parent_post_id, 'parent_post_id');
    const caseId = optionalUuid(input.case_id, 'case_id');
    const taskId = optionalUuid(input.task_id, 'task_id');

    const postId = await store.addPost({
      threadId: thread.threadId,
      actor: ctx.userId,
      parentPostId,
      body,
      caseId,
      taskId,
    });
    return NextResponse.json({ postId }, { status: 201 });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
