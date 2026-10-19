// ============================================================
// /api/banks/[id]/threads — the workspace's discussion (018c, 126).
// INTERNAL ONLY: thread text never reaches a customer and is never logged.
// GET -> `{ threads }`.
// POST `{ title, body, case_id?, task_id? }` (title 1–200, body 1–4000,
// trimmed; the link is a case of the bank or a task of one) -> 201
// `{ threadId }`. Postgres decides who may post (NOT_ALLOWED, 403).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  bankErrorResponse,
  loadBankWorkspace,
  optionalUuid,
  requiredText,
} from '@/lib/cases/bank-http';
import { BANK_WS_CAPS } from '@/lib/cases/bank-workspaces';
import { badRequest, readJsonObject } from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    return NextResponse.json({
      threads: await store.threads(workspace.bankWsId, ctx.userId),
    });
  } catch (err) {
    return bankErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    const input = await readJsonObject(request);
    if (!input) throw badRequest('Body must be a JSON object');
    const title = requiredText(input.title, 'title', BANK_WS_CAPS.title);
    const body = requiredText(input.body, 'body', BANK_WS_CAPS.body);
    const caseId = optionalUuid(input.case_id, 'case_id');
    const taskId = optionalUuid(input.task_id, 'task_id');

    const threadId = await store.createThread({
      bankWsId: workspace.bankWsId,
      actor: ctx.userId,
      title,
      body,
      caseId,
      taskId,
    });
    return NextResponse.json({ threadId }, { status: 201 });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
