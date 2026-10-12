/**
 * Request validation for the tasks API (`/api/tasks/**`), and the one
 * mapping from a database refusal to an answer. Pure apart from that
 * mapping's log line, so the routes stay thin and this is tested.
 *
 * Request bodies are camelCase; what a parser returns is the columns
 * it sets, ready for `.insert()` / `.update()`.
 */

import { NextResponse } from 'next/server';

import { charLength } from './text';
import {
  TASK_LIST_SCOPES,
  TASK_NOTE_MAX,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  USER_TASK_KINDS,
  USER_TASK_SOURCES,
  type NewTaskValues,
  type TaskListQuery,
  type TaskPatchValues,
} from './types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An ISO 8601 date-time that names its offset. A zoneless one would be
 * read in the server's time zone, so the same body could mean a
 * different moment on another install.
 */
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;
const LIST_STATUSES = [...TASK_STATUSES, 'all'] as const;

type Parsed<T> = { ok: true; values: T } | { ok: false; error: string };

/** A `[id]` route segment shaped like a task id. */
export function isTaskId(id: string): boolean {
  return UUID_RE.test(id);
}

// Field readers throw `Invalid` with the 400's wording; `parsing`
// turns the first one into `{ ok: false, error }`.
class Invalid extends Error {}

function fail(error: string): never {
  throw new Invalid(error);
}

function parsing<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, values: read() };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('Invalid request body');
  }
  return body as Record<string, unknown>;
}

function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  key: string
): T {
  if (!(allowed as readonly unknown[]).includes(raw)) {
    fail(`${key} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

function readTitle(raw: unknown): string {
  if (typeof raw !== 'string') fail('title must be a string');
  const title = raw.trim();
  if (!title) fail('title cannot be empty');
  if (charLength(title) > TASK_TITLE_MAX) {
    fail(`title must be at most ${TASK_TITLE_MAX} characters`);
  }
  return title;
}

/** A trimmed note; blank or null is null. */
function readNote(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') fail('note must be a string or null');
  const note = raw.trim();
  if (charLength(note) > TASK_NOTE_MAX) {
    fail(`note must be at most ${TASK_NOTE_MAX} characters`);
  }
  return note || null;
}

/** A UUID, or null (absent counts as null). */
function readId(raw: unknown, key: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    fail(`${key} must be an id or null`);
  }
  return raw;
}

/** An ISO date-time with its offset, as `toISOString()`; or null. */
function readDueAt(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && ISO_DATE_TIME_RE.test(raw)) {
    const time = Date.parse(raw);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return fail(
    'dueAt must be an ISO 8601 date-time with a time zone, such as 2026-10-12T09:00:00Z, or null'
  );
}

/**
 * Validate a `POST /api/tasks` body (`CreateTaskBody`). `title` is
 * required; `kind` defaults to manual and `source` to manual (a member
 * may only write manual or chat tasks, of a kind a person may file). `assignedTo` left out assigns
 * the task to `callerId`; `null` leaves it unassigned. Unknown keys are
 * ignored.
 */
export function parseCreateTaskBody(
  body: unknown,
  callerId: string
): Parsed<NewTaskValues> {
  return parsing(() => {
    const b = objectBody(body);
    return {
      title: readTitle(b.title),
      note: readNote(b.note),
      kind: oneOf(b.kind ?? 'manual', USER_TASK_KINDS, 'kind'),
      source: oneOf(b.source ?? 'manual', USER_TASK_SOURCES, 'source'),
      contact_id: readId(b.contactId, 'contactId'),
      conversation_id: readId(b.conversationId, 'conversationId'),
      deal_id: readId(b.dealId, 'dealId'),
      assigned_to:
        b.assignedTo === undefined
          ? callerId
          : readId(b.assignedTo, 'assignedTo'),
      due_at: readDueAt(b.dueAt),
    };
  });
}

/**
 * Validate a `PATCH /api/tasks/[id]` body (`TaskPatch`): any of status,
 * title, note, assignedTo, dueAt, at least one. Absent keys are left
 * unchanged; `null` clears note, assignee or due date. Unknown keys are
 * ignored.
 */
export function parseTaskPatch(body: unknown): Parsed<TaskPatchValues> {
  return parsing(() => {
    const b = objectBody(body);
    const values: TaskPatchValues = {};
    if (b.status !== undefined) {
      values.status = oneOf(b.status, TASK_STATUSES, 'status');
    }
    if (b.title !== undefined) values.title = readTitle(b.title);
    if (b.note !== undefined) values.note = readNote(b.note);
    if (b.assignedTo !== undefined) {
      values.assigned_to = readId(b.assignedTo, 'assignedTo');
    }
    if (b.dueAt !== undefined) values.due_at = readDueAt(b.dueAt);
    if (Object.keys(values).length === 0) fail('Nothing to update');
    return values;
  });
}

/**
 * Validate `GET /api/tasks` search params. `scope` is mine (default:
 * assigned to the caller), all (whatever RLS shows the caller),
 * contact (needs `contactId`) or conversation (needs
 * `conversationId`); `status` is open (default), done, cancelled or
 * all; `limit` is 1–200, default 100.
 */
export function parseTaskListQuery(
  params: URLSearchParams
): { ok: true; query: TaskListQuery } | { ok: false; error: string } {
  const parsed = parsing((): TaskListQuery => {
    const scope = oneOf(
      params.get('scope') || 'mine',
      TASK_LIST_SCOPES,
      'scope'
    );
    const status = oneOf(
      params.get('status') || 'open',
      LIST_STATUSES,
      'status'
    );

    let limit = LIST_LIMIT_DEFAULT;
    const rawLimit = params.get('limit');
    if (rawLimit) {
      limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!(limit >= 1 && limit <= LIST_LIMIT_MAX)) {
        fail(`limit must be a whole number from 1 to ${LIST_LIMIT_MAX}`);
      }
    }

    if (scope === 'contact') {
      return {
        scope,
        contactId: requiredId(params, 'contactId'),
        status,
        limit,
      };
    }
    if (scope === 'conversation') {
      const conversationId = requiredId(params, 'conversationId');
      return { scope, conversationId, status, limit };
    }
    return { scope, status, limit };
  });
  return parsed.ok ? { ok: true, query: parsed.values } : parsed;
}

function requiredId(params: URLSearchParams, key: string): string {
  const id = params.get(key);
  if (!id || !UUID_RE.test(id)) fail(`${key} must be an id for this scope`);
  return id;
}

/**
 * The answer to a database error from a task write. The table's
 * triggers refuse with 23514 and a sentence written for people (an
 * assignee who can't hold tasks, say), so that message is passed on;
 * an RLS refusal (42501) gets one plain sentence. Anything else is
 * logged and answered with `fallback`, never the raw error.
 */
export function taskDbErrorResponse(
  error: { code?: string; message?: string },
  fallback: string
): NextResponse {
  switch (error.code) {
    case '42501':
      return NextResponse.json(
        { error: "You can't make that change to this task" },
        { status: 403 }
      );
    case '23514':
      return NextResponse.json(
        { error: error.message || fallback },
        { status: 400 }
      );
    case '23503':
      return NextResponse.json(
        {
          error: 'A linked contact, conversation, deal or person was not found',
        },
        { status: 400 }
      );
    case '22P02':
    case '22007':
    case '22008':
      return NextResponse.json({ error: 'Invalid value' }, { status: 400 });
    case '23505':
      return NextResponse.json(
        { error: 'That task already exists' },
        { status: 409 }
      );
    default:
      console.error(`[tasks] ${fallback}:`, error);
      return NextResponse.json({ error: fallback }, { status: 500 });
  }
}
