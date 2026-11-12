import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { isUuid } from '@/lib/coordinators/errors';
import { parseReminderSuggestionAction } from '@/lib/reminders/requests';
import { REMINDER_SUGGESTION_COLUMNS } from '@/lib/reminders/types';

type Params = { params: Promise<{ id: string }> };

const TABLE = 'message_reminder_suggestions';

/**
 * A suggestion that may become added or dismissed: still open, or added
 * but its task was deleted (task_id went back to NULL, ON DELETE SET NULL).
 */
const ACTIONABLE_FILTER = 'status.eq.open,and(status.eq.added,task_id.is.null)';

/**
 * POST /api/inbox/reminder-suggestions/[id]  (agent+)
 *
 * Body: `{ action: 'added', taskId }` | `{ action: 'dismissed' }` |
 * `{ action: 'reopen' }` (the Undo of a dismiss).
 * Returns: `{ suggestion }`; 409 `{ error, suggestion }` when the row
 * had already moved on, with the row as the caller now reads it.
 *
 * Clients may only SELECT message_reminder_suggestions (migration 197).
 * The caller's RLS read is the authorisation (same active account, can
 * see the chat); the write is the service role's, compare-and-set on
 * the status the action starts from, so two agents racing on one chip
 * settle once.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: 'Suggestion not found' },
        { status: 404 }
      );
    }
    const parsed = parseReminderSuggestionAction(
      await request.json().catch(() => null)
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const action = parsed.value;

    const { data: suggestion, error: readErr } = await supabase
      .from(TABLE)
      .select(REMINDER_SUGGESTION_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (readErr) {
      console.error('[reminder-suggestions] read error:', readErr.message);
      return NextResponse.json(
        { error: 'Failed to load the suggestion' },
        { status: 500 }
      );
    }
    if (!suggestion || suggestion.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Suggestion not found' },
        { status: 404 }
      );
    }

    if (action.action === 'added') {
      // The task must be one the caller can see, filed on this chat.
      const { data: task, error: taskErr } = await supabase
        .from('tasks')
        .select('id, conversation_id')
        .eq('id', action.taskId)
        .maybeSingle();
      if (taskErr) {
        console.error(
          '[reminder-suggestions] task read error:',
          taskErr.message
        );
        return NextResponse.json(
          { error: 'Failed to load the task' },
          { status: 500 }
        );
      }
      if (!task || task.conversation_id !== suggestion.conversation_id) {
        return NextResponse.json(
          { error: 'That task is not a reminder on this chat.' },
          { status: 400 }
        );
      }
    }

    const now = new Date().toISOString();
    const patch =
      action.action === 'added'
        ? {
            status: 'added',
            task_id: action.taskId,
            acted_by: userId,
            acted_at: now,
          }
        : action.action === 'dismissed'
          ? {
              status: 'dismissed',
              task_id: null,
              acted_by: userId,
              acted_at: now,
            }
          : { status: 'open', task_id: null, acted_by: null, acted_at: null };

    const update = supabaseAdmin()
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId);
    const guarded =
      action.action === 'reopen'
        ? update.eq('status', 'dismissed')
        : update.or(ACTIONABLE_FILTER);
    const { data: row, error: writeErr } = await guarded
      .select(REMINDER_SUGGESTION_COLUMNS)
      .maybeSingle();
    if (writeErr) {
      console.error('[reminder-suggestions] write error:', writeErr.message);
      return NextResponse.json(
        { error: 'Failed to update the suggestion' },
        { status: 500 }
      );
    }
    if (row) return NextResponse.json({ suggestion: row });

    // Lost the compare-and-set: hand back what the caller now reads.
    const { data: current } = await supabase
      .from(TABLE)
      .select(REMINDER_SUGGESTION_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    return NextResponse.json(
      {
        error: 'This suggestion has already been changed.',
        suggestion: current ?? null,
      },
      { status: 409 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
