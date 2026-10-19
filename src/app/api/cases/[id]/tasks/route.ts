// ============================================================
// /api/cases/[id]/tasks — the case's tasks (018c, migration 123).
// GET (any case role): `{ tasks, templates }`, the templates of the
// case's bank (none when it has no bank). POST (case writers)
// `{ template_key, owner_id?, due_at? }` creates a task from one of
// those templates -> 201 `{ taskId }`; owner defaults to the case's
// agent and due to the template's due_hours (SQL decides both).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  CaseHttpError,
  caseErrorResponse,
  isUuid,
  loadCaseForCaller,
  optionalDate,
  readObject,
  requiredKey,
} from '@/lib/cases/route-helpers';
import { caseStore, caseToolsStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      caseStore(ctx.accountId),
      ctx,
      id,
      {
        write: false,
      }
    );
    const tools = caseToolsStore();
    const [tasks, templates] = await Promise.all([
      tools.listTasks(c.id),
      c.bankCode
        ? tools.bankConfig(c.accountId, c.bankCode).then((b) => b.templates)
        : Promise.resolve([]),
    ]);
    return NextResponse.json({ tasks, templates });
  } catch (err) {
    return caseErrorResponse(err, 'tasks GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      caseStore(ctx.accountId),
      ctx,
      id,
      {
        write: true,
      }
    );
    const body = await readObject(request);
    const templateKey = requiredKey(body.template_key, 'template_key');
    const ownerId = body.owner_id ?? null;
    if (ownerId !== null && !isUuid(ownerId))
      throw new CaseHttpError(400, 'owner_id must be a uuid');
    const dueAt = optionalDate(body.due_at, 'due_at');

    const taskId = await caseToolsStore().createTask({
      caseId: c.id,
      actor: ctx.userId,
      templateKey,
      ownerId,
      dueAt,
    });
    return NextResponse.json({ taskId }, { status: 201 });
  } catch (err) {
    return caseErrorResponse(err, 'tasks POST');
  }
}
