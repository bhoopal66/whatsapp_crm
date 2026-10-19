// ============================================================
// /api/cases/[id]/tasks/[taskId] — a task's status (018c, migration 123).
// PATCH (case writers) `{ status: 'open' | 'done' | 'blocked' }` ->
// 200 `{ changed, fromStatus, toStatus }`. The task must be one of this
// case's (checked against the case's task list; 404 otherwise), since
// case_task_set_status judges the task's own case, not the URL's.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  CaseHttpError,
  caseErrorResponse,
  isUuid,
  loadCaseForCaller,
  oneOf,
  readObject,
} from '@/lib/cases/route-helpers';
import { caseStore, caseToolsStore } from '@/lib/cases/server';
import type { TaskStatus } from '@/lib/cases/tools';

type Params = { params: Promise<{ id: string; taskId: string }> };

const STATUSES: readonly TaskStatus[] = ['open', 'done', 'blocked'];

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, taskId } = await params;
    const { case: c } = await loadCaseForCaller(
      caseStore(ctx.accountId),
      ctx,
      id,
      {
        write: true,
      }
    );
    if (!isUuid(taskId)) throw new CaseHttpError(404, 'Task not found');
    const status = oneOf(
      (await readObject(request)).status,
      STATUSES,
      'status'
    );

    const tools = caseToolsStore();
    const tasks = await tools.listTasks(c.id);
    if (!tasks.some((t) => t.id === taskId))
      throw new CaseHttpError(404, 'Task not found');

    const result = await tools.setTaskStatus(taskId, ctx.userId, status);
    return NextResponse.json(result);
  } catch (err) {
    return caseErrorResponse(err, 'task PATCH');
  }
}
