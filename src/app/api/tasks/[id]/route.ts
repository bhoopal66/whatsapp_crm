// ============================================================
// /api/tasks/[id] — change or delete one task (migration 085).
//
// Under the caller's RLS client. A row the policies don't let them
// touch answers no row (404); a write the policy's check or a trigger
// refuses is mapped by `taskDbErrorResponse`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  isTaskId,
  parseTaskPatch,
  taskDbErrorResponse,
} from '@/lib/tasks/requests';
import { TASK_COLUMNS } from '@/lib/tasks/types';

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/tasks/[id] (agent+) → `{ task }`. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!isTaskId(id)) {
      return NextResponse.json({ error: 'Invalid task id' }, { status: 400 });
    }
    const parsed = parseTaskPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(parsed.values)
      .eq('account_id', accountId)
      .eq('id', id)
      .select(TASK_COLUMNS)
      .maybeSingle();
    if (error) return taskDbErrorResponse(error, 'Failed to update task');
    if (!data) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ task: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/tasks/[id] (agent+) → `{ ok: true }`. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!isTaskId(id)) {
      return NextResponse.json({ error: 'Invalid task id' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id');
    if (error) return taskDbErrorResponse(error, 'Failed to delete task');
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
