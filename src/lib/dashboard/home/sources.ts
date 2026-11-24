import type { InboxRow } from '@/lib/cases/ui';
import type { Task } from '@/lib/tasks/types';

// ------------------------------------------------------------
// The two lists more than one home widget reads: the person's open
// tasks (the attention strip's overdue count and the tasks panel) and
// the open cases they may read (the strip's overdue count and the cases
// card). The page loads each once per refresh and hands the same result
// to both, so neither is asked twice. Both go through the existing
// routes, which scope them server-side: tasks to `assigned_to = me`,
// cases to `case_inbox`'s role rules.
// ------------------------------------------------------------

/** One request's worth; both routes cap here (`INBOX_MAX_LIMIT`, tasks' 200). */
export const HOME_LIST_LIMIT = 200;

export interface OpenCases {
  /** Most overdue first (`case_inbox`'s default sort). */
  rows: InboxRow[];
  /** More open cases exist than were read, so counts are "at least". */
  truncated: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

export interface OpenTasks {
  /** Soonest due first, undated last. */
  tasks: Task[];
  /** More open tasks exist than were read, so counts are "at least". */
  truncated: boolean;
}

/** The person's open tasks, soonest due first, undated last. */
export async function fetchMyOpenTasks(): Promise<OpenTasks> {
  const body = await getJson<{ tasks?: Task[]; truncated?: boolean }>(
    `/api/tasks?scope=mine&status=open&limit=${HOME_LIST_LIMIT}`
  );
  return { tasks: body.tasks ?? [], truncated: !!body.truncated };
}

/** The open cases (leads included) this person may read. */
export async function fetchOpenCases(): Promise<OpenCases> {
  const body = await getJson<{
    rows?: InboxRow[];
    nextCursor?: string | null;
  }>(`/api/cases?limit=${HOME_LIST_LIMIT}`);
  return { rows: body.rows ?? [], truncated: !!body.nextCursor };
}
