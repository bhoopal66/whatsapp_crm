import type { SupabaseClient } from '@supabase/supabase-js';

import { missedTaskFor, type TimelineTask } from './timeline';

/** A missed call's callback task, as the Calls screen's badge says it. */
export interface MissedCallTask {
  status: string;
  /**
   * Open: who holds it. Done: who closed it, or who spoke to the
   * customer when a call closed it (`meta.spoke_user_id`, process.ts).
   * Null when nobody is known.
   */
  name: string | null;
}

const PAGE = 1000;
/** A hard stop: PAGE tasks each, the most recently touched first. */
const MAX_PAGES = 10;
/** The PBX's clock can run ahead of the database's. */
const CLOCK_MARGIN_MS = 60 * 60 * 1000;

type TaskRow = TimelineTask & { completed_by: string | null };

/**
 * The callback task of each of `calls` that has one. RLS shows a member
 * their own tasks, so on their own read a ring group's other people saw
 * a call with no badge and rang the customer again. `db` is the service
 * role: pass only calls the caller's own RLS read returned; what leaves
 * here is each one's status and a colleague's name.
 *
 * A task is written when a call it holds ends, so every one holding a
 * listed call was touched after the earliest of them started.
 */
export async function missedCallTasks(
  db: SupabaseClient,
  accountId: string,
  calls: readonly { id: string; started_at: string }[]
): Promise<Map<string, MissedCallTask>> {
  const out = new Map<string, MissedCallTask>();
  if (!calls.length) return out;
  const since = new Date(
    Math.min(...calls.map((c) => Date.parse(c.started_at))) - CLOCK_MARGIN_MS
  ).toISOString();
  const tasks: TaskRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from('tasks')
      .select(
        'id, kind, title, status, due_at, assigned_to, completed_by, source_ref, meta'
      )
      .eq('account_id', accountId)
      .eq('source', 'pbx')
      .eq('kind', 'missed_call')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw new Error(`tasks read failed: ${error.message}`);
    const rows = (data ?? []) as TaskRow[];
    tasks.push(...rows);
    if (rows.length < PAGE) break;
  }

  const found = new Map<string, TaskRow>();
  for (const c of calls) {
    const task = missedTaskFor(c.id, tasks);
    if (task) found.set(c.id, task);
  }
  const person = (t: TaskRow): string | null => {
    if (t.status === 'open') return t.assigned_to;
    if (t.status !== 'done') return null;
    const spoke = t.meta?.spoke_user_id;
    return t.completed_by ?? (typeof spoke === 'string' ? spoke : null);
  };
  const ids = [
    ...new Set([...found.values()].map(person).filter((id) => id !== null)),
  ];
  const names = new Map<string, string | null>();
  if (ids.length) {
    const { data, error } = await db
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId)
      .in('user_id', ids);
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    for (const p of (data ?? []) as {
      user_id: string;
      full_name: string | null;
    }[])
      names.set(p.user_id, p.full_name?.trim() || null);
  }
  for (const [callId, task] of found) {
    const id = person(task);
    out.set(callId, {
      status: task.status,
      name: (id && names.get(id)) || null,
    });
  }
  return out;
}

/** The badge's `CallsPage` message: who it is left to, or who did it. */
export function missedBadge(task: MissedCallTask): {
  key: 'taskOpen' | 'taskOpenBy' | 'taskDone' | 'taskDoneBy';
  name: string;
} {
  const name = task.name ?? '';
  if (task.status === 'open')
    return { key: name ? 'taskOpenBy' : 'taskOpen', name };
  return { key: name ? 'taskDoneBy' : 'taskDone', name };
}
