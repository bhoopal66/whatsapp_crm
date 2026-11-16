/**
 * Pure logic behind `/hr-inbox/tasks`. An HR task is a `tasks` row a
 * workflow rule opened (migration 200): `source = 'automation'` and a
 * `source_ref` of `hr:<conversation id>:<dedupe key>`. Who sees which
 * one is RLS's business (085); this only sorts and filters what came.
 */
import type { Task } from '@/lib/tasks/types';

export const HR_TASK_REF_PREFIX = 'hr:';

export function isHrTask(task: Pick<Task, 'source' | 'source_ref'>): boolean {
  return (
    task.source === 'automation' &&
    typeof task.source_ref === 'string' &&
    task.source_ref.startsWith(HR_TASK_REF_PREFIX)
  );
}

/** The chat ids a task list points at, each once. */
export function taskConversationIds(
  tasks: Pick<Task, 'conversation_id'>[]
): string[] {
  return [
    ...new Set(
      tasks.map((t) => t.conversation_id).filter((id): id is string => !!id)
    ),
  ];
}

/**
 * A customer name per task id, read through the task's chat (an HR task
 * carries no `contact_id`, for privacy). A chat the viewer cannot see,
 * or a nameless contact, gets no entry.
 */
export function customerNamesByTask(
  tasks: Pick<Task, 'id' | 'conversation_id'>[],
  chats: { id: string; contact: { name: string | null } | null }[]
): Record<string, string> {
  const byChat = new Map<string, string>();
  for (const c of chats) {
    const name = c.contact?.name?.trim();
    if (name) byChat.set(c.id, name);
  }
  const out: Record<string, string> = {};
  for (const t of tasks) {
    const name = t.conversation_id ? byChat.get(t.conversation_id) : undefined;
    if (name) out[t.id] = name;
  }
  return out;
}

/** Open and past its due time. */
export function isOverdue(
  task: Pick<Task, 'status' | 'due_at'>,
  now: number
): boolean {
  if (task.status !== 'open' || !task.due_at) return false;
  const due = Date.parse(task.due_at);
  return Number.isFinite(due) && due < now;
}

export interface HrTaskFilter {
  mine: boolean;
  overdueOnly: boolean;
  userId: string | null;
  now: number;
}

/**
 * Open HR tasks, soonest due first, undated last, then newest. "Mine"
 * is assigned to me.
 */
export function visibleHrTasks<T extends Task>(
  tasks: T[],
  filter: HrTaskFilter
): T[] {
  return tasks
    .filter(
      (t) =>
        t.status === 'open' &&
        isHrTask(t) &&
        (!filter.mine || t.assigned_to === filter.userId) &&
        (!filter.overdueOnly || isOverdue(t, filter.now))
    )
    .sort((a, b) => {
      const da = a.due_at ? Date.parse(a.due_at) : Infinity;
      const db = b.due_at ? Date.parse(b.due_at) : Infinity;
      if (da !== db) return da < db ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
}
