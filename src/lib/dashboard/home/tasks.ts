import type { Task } from '@/lib/tasks/types';

// ------------------------------------------------------------
// The home "My tasks" panel and the attention strip's task tile, as
// pure functions over the open-task list. Days are the viewer's local
// days (the browser's zone), as is the due time shown on each row.
// ------------------------------------------------------------

export interface TaskBuckets {
  /** Due before now, most overdue first. */
  overdue: Task[];
  /** Due later today. */
  today: Task[];
  /** Due in the seven days after today. */
  upcoming: Task[];
  /** Due after that. */
  later: Task[];
  /** No due date, oldest first. */
  undated: Task[];
}

/** Local midnight `days` days after `now`'s day (DST-safe). */
export function localDayStart(now: Date, days = 0): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + days
  ).getTime();
}

const dueMs = (t: Pick<Task, 'due_at'>): number | null => {
  if (!t.due_at) return null;
  const ms = Date.parse(t.due_at);
  return Number.isFinite(ms) ? ms : null;
};

const byCreated = (a: Task, b: Task) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const byDue = (a: Task, b: Task) =>
  (dueMs(a) ?? 0) - (dueMs(b) ?? 0) || byCreated(a, b);

/** Sort open tasks into the panel's groups. Tasks not open are left out. */
export function bucketTasks(tasks: readonly Task[], now: Date): TaskBuckets {
  const nowMs = now.getTime();
  const tomorrow = localDayStart(now, 1);
  const weekEnd = localDayStart(now, 8);
  const out: TaskBuckets = {
    overdue: [],
    today: [],
    upcoming: [],
    later: [],
    undated: [],
  };
  for (const task of tasks) {
    if (task.status !== 'open') continue;
    const due = dueMs(task);
    if (due === null) out.undated.push(task);
    else if (due < nowMs) out.overdue.push(task);
    else if (due < tomorrow) out.today.push(task);
    else if (due < weekEnd) out.upcoming.push(task);
    else out.later.push(task);
  }
  out.overdue.sort(byDue);
  out.today.sort(byDue);
  out.upcoming.sort(byDue);
  out.later.sort(byDue);
  out.undated.sort(byCreated);
  return out;
}

/**
 * The first `limit` tasks across `groups`, in group order, each group
 * keeping its own rows (empty groups included, so the caller can skip
 * them).
 */
export function limitGroups<G extends keyof TaskBuckets>(
  buckets: TaskBuckets,
  groups: readonly G[],
  limit: number
): { group: G; rows: Task[] }[] {
  const out: { group: G; rows: Task[] }[] = [];
  let left = limit;
  for (const group of groups) {
    const rows = buckets[group].slice(0, Math.max(0, left));
    left -= rows.length;
    out.push({ group, rows });
  }
  return out;
}

/** The figures the strip and the panel's subtitle show. */
export function taskCounts(
  tasks: readonly Task[],
  now: Date
): { overdue: number; today: number; open: number } {
  const b = bucketTasks(tasks, now);
  return {
    overdue: b.overdue.length,
    today: b.today.length,
    open:
      b.overdue.length +
      b.today.length +
      b.upcoming.length +
      b.later.length +
      b.undated.length,
  };
}

/** How a row words its due time. */
export type DueLabel =
  | { kind: 'none' }
  /** Past due by `amount` minutes, hours or days (rounded down, at least 1). */
  | { kind: 'overdue'; amount: number; unit: 'minute' | 'hour' | 'day' }
  /** Later today: the clock time. */
  | { kind: 'time'; ms: number }
  /** Within the coming week: the weekday and time. */
  | { kind: 'weekday'; ms: number }
  /** Further out: the date. */
  | { kind: 'date'; ms: number };

export function dueLabel(task: Pick<Task, 'due_at'>, now: Date): DueLabel {
  const due = dueMs(task);
  if (due === null) return { kind: 'none' };
  const nowMs = now.getTime();
  if (due < nowMs) {
    const minutes = Math.max(1, Math.floor((nowMs - due) / 60_000));
    if (minutes < 60)
      return { kind: 'overdue', amount: minutes, unit: 'minute' };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { kind: 'overdue', amount: hours, unit: 'hour' };
    return { kind: 'overdue', amount: Math.floor(hours / 24), unit: 'day' };
  }
  if (due < localDayStart(now, 1)) return { kind: 'time', ms: due };
  if (due < localDayStart(now, 8)) return { kind: 'weekday', ms: due };
  return { kind: 'date', ms: due };
}

/**
 * Folded repeat misses on a missed-call task (`meta.missed_count`, set
 * by the PBX processor), when more than one; otherwise null.
 */
export function missedRepeat(task: Pick<Task, 'kind' | 'meta'>): number | null {
  if (task.kind !== 'missed_call') return null;
  const n = (task.meta as { missed_count?: unknown } | null)?.missed_count;
  return typeof n === 'number' && Number.isFinite(n) && n > 1
    ? Math.floor(n)
    : null;
}

/** Where a row's customer link goes: the contact, else the chat. */
export function taskTarget(
  task: Pick<Task, 'contact_id' | 'conversation_id'>
): { href: string; kind: 'contact' | 'conversation' } | null {
  if (task.contact_id)
    return { href: `/contacts/${task.contact_id}`, kind: 'contact' };
  if (task.conversation_id)
    return { href: `/inbox?c=${task.conversation_id}`, kind: 'conversation' };
  return null;
}

/** The distinct contact ids the list links to, sorted, for one name lookup. */
export function taskContactIds(tasks: readonly Task[]): string[] {
  const ids = new Set<string>();
  for (const t of tasks) if (t.contact_id) ids.add(t.contact_id);
  return [...ids].sort();
}
