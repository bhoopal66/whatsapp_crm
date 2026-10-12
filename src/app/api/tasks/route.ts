// ============================================================
// /api/tasks — list and create tasks (migration 085).
//
// Both run under the caller's own RLS client: the tasks policies decide
// which tasks a member sees and may write, and the table's triggers
// decide who can hold one. Their refusals are mapped by
// `taskDbErrorResponse` (42501 → 403, a trigger's 23514 → 400 with its
// own sentence).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  parseCreateTaskBody,
  parseTaskListQuery,
  taskDbErrorResponse,
} from '@/lib/tasks/requests';
import { TASK_COLUMNS } from '@/lib/tasks/types';

/**
 * GET /api/tasks?scope=&contactId=&conversationId=&status=&limit=
 * (viewer+) → `{ tasks }`. Open tasks first (status DESC puts open
 * before done and cancelled), then soonest due, undated last, then
 * newest.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('viewer');
    const parsed = parseTaskListQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { query } = parsed;

    let tasks = supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('account_id', accountId);
    if (query.scope === 'mine') tasks = tasks.eq('assigned_to', userId);
    if (query.scope === 'contact') {
      tasks = tasks.eq('contact_id', query.contactId);
    }
    if (query.scope === 'conversation') {
      tasks = tasks.eq('conversation_id', query.conversationId);
    }
    if (query.status !== 'all') tasks = tasks.eq('status', query.status);

    const { data, error } = await tasks
      .order('status', { ascending: false })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(query.limit);
    if (error) {
      console.error('[tasks GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load tasks' },
        { status: 500 }
      );
    }
    return NextResponse.json({ tasks: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/tasks (agent+) → 201 `{ task }`. A task linked to a chat
 * but not to a contact takes the chat's contact, read through the
 * caller's RLS: a chat they can't see is a 404, never a link.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const parsed = parseCreateTaskBody(
      await request.json().catch(() => null),
      userId
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const values = { ...parsed.values };

    if (values.conversation_id && !values.contact_id) {
      const { data: conversation, error } = await supabase
        .from('conversations')
        .select('contact_id')
        .eq('account_id', accountId)
        .eq('id', values.conversation_id)
        .maybeSingle();
      if (error) return taskDbErrorResponse(error, 'Failed to create task');
      if (!conversation) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      values.contact_id = conversation.contact_id;
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({ ...values, account_id: accountId, created_by: userId })
      .select(TASK_COLUMNS)
      .single();
    if (error) return taskDbErrorResponse(error, 'Failed to create task');
    return NextResponse.json({ task: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
