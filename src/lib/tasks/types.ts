/**
 * Shapes for the Tasks module (migration 085, `public.tasks`).
 *
 * A task is a to-do for a person: one an agent writes by hand, or one
 * the system opens (a missed call from the PBX, a journey step, an
 * automation). System tasks carry `source` + `source_ref`, unique per
 * account, which is how the same event never opens two of them.
 */

export const TASK_KINDS = [
  'manual',
  'callback',
  'missed_call',
  'journey',
  'follow_up',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SOURCES = [
  'manual',
  'pbx',
  'journey',
  'chat',
  'automation',
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/** The sources a member's own insert may carry (the RLS insert policy). */
export const USER_TASK_SOURCES = [
  'manual',
  'chat',
] as const satisfies readonly TaskSource[];
export type UserTaskSource = (typeof USER_TASK_SOURCES)[number];

/** The sources only the service role writes: 'pbx' | 'journey' | 'automation'. */
export type SystemTaskSource = Exclude<TaskSource, UserTaskSource>;

/** One `public.tasks` row. */
export interface Task {
  id: string;
  account_id: string;
  kind: TaskKind;
  title: string;
  note: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  deal_id: string | null;
  /** An auth user id: an active agent or above of the account. */
  assigned_to: string | null;
  due_at: string | null;
  status: TaskStatus;
  source: TaskSource;
  source_ref: string | null;
  meta: Record<string, unknown>;
  /** Null for a task the system opened. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Stamped by the trigger when the status changes. */
  completed_at: string | null;
  completed_by: string | null;
}

/** Every `Task` column, for `.select()`. */
export const TASK_COLUMNS =
  'id, account_id, kind, title, note, contact_id, conversation_id, deal_id, assigned_to, due_at, status, source, source_ref, meta, created_by, created_at, updated_at, completed_at, completed_by';

/** Longest title and note, in characters (the table's CHECKs). */
export const TASK_TITLE_MAX = 300;
export const TASK_NOTE_MAX = 4000;

/**
 * The body of `POST /api/tasks`. Only `title` is required. `assignedTo`
 * left out means the caller; `null` leaves the task unassigned. `dueAt`
 * is an ISO 8601 date-time with a time zone (`toISOString()` output).
 */
export interface CreateTaskBody {
  title: string;
  note?: string | null;
  kind?: TaskKind;
  source?: UserTaskSource;
  contactId?: string | null;
  conversationId?: string | null;
  dealId?: string | null;
  assignedTo?: string | null;
  dueAt?: string | null;
}

/** A validated `CreateTaskBody`, as the columns it sets. */
export interface NewTaskValues {
  kind: TaskKind;
  title: string;
  note: string | null;
  source: UserTaskSource;
  contact_id: string | null;
  conversation_id: string | null;
  deal_id: string | null;
  assigned_to: string | null;
  due_at: string | null;
}

/** The body of `PATCH /api/tasks/[id]`: at least one of these. */
export interface TaskPatch {
  status?: TaskStatus;
  title?: string;
  note?: string | null;
  assignedTo?: string | null;
  dueAt?: string | null;
}

/** A validated `TaskPatch`, as the columns it changes. */
export interface TaskPatchValues {
  status?: TaskStatus;
  title?: string;
  note?: string | null;
  assigned_to?: string | null;
  due_at?: string | null;
}

export const TASK_LIST_SCOPES = [
  'mine',
  'all',
  'contact',
  'conversation',
] as const;
export type TaskListScope = (typeof TASK_LIST_SCOPES)[number];

/** `GET /api/tasks` query: which tasks, which status, how many. */
export type TaskListQuery = {
  status: TaskStatus | 'all';
  limit: number;
} & (
  | { scope: 'mine' | 'all' }
  | { scope: 'contact'; contactId: string }
  | { scope: 'conversation'; conversationId: string }
);

/** A task the system opens (`createSystemTask`, service role). */
export interface SystemTaskInput {
  accountId: string;
  kind: TaskKind;
  /** Generated text: trimmed, and cut to `TASK_TITLE_MAX` if longer. */
  title: string;
  note?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  dealId?: string | null;
  assignedTo?: string | null;
  dueAt?: string | null;
  source: SystemTaskSource;
  /** The event's own id (a call id, a journey step); never blank. */
  sourceRef: string;
  meta?: Record<string, unknown>;
}
