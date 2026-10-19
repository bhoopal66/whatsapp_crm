/**
 * The case page's tool tabs (Tasks, Documents, Notes, Bank contacts):
 * the pure rules they share. No React, no I/O.
 */

export type TaskStatus = 'open' | 'done' | 'blocked';

/** Overdue: a due time before `now` on a task that is not done. */
export function isTaskOverdue(
  task: { dueAt: string | null; status: TaskStatus },
  now: Date | number
): boolean {
  if (!task.dueAt || task.status === 'done') return false;
  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return due < (typeof now === 'number' ? now : now.getTime());
}

/** Tasks by due time (soonest first, none last), then newest first. */
export function sortTasks<
  T extends { dueAt: string | null; createdAt: string },
>(tasks: T[]): T[] {
  const time = (iso: string | null) => {
    const v = iso ? new Date(iso).getTime() : NaN;
    return Number.isNaN(v) ? Infinity : v;
  };
  return [...tasks].sort(
    (a, b) =>
      time(a.dueAt) - time(b.dueAt) || b.createdAt.localeCompare(a.createdAt)
  );
}

// ------------------------------------------------------------------ Mentions

const MENTION_RE =
  /@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

export type NoteSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string; name: string | null };

/**
 * A stored note body as text and mention segments (rendered as React
 * text, never HTML). `@<uuid>` becomes a mention; `name` is null for
 * someone the member list does not know.
 */
export function renderMentions(
  body: string,
  nameOf: (userId: string) => string | null
): NoteSegment[] {
  const out: NoteSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: body.slice(last, at) });
    const userId = m[1].toLowerCase();
    out.push({ kind: 'mention', userId, name: nameOf(userId) });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) });
  return out;
}

/**
 * The body with `@<userId> ` inserted at `cursor`, and where the cursor
 * goes next. An `@` typed just before the cursor (what opened the
 * picker) is consumed; a handle never glues onto the previous word.
 */
export function insertMention(
  body: string,
  cursor: number,
  userId: string
): { body: string; cursor: number } {
  let at = Math.max(
    0,
    Math.min(Number.isFinite(cursor) ? cursor : body.length, body.length)
  );
  const after = body.slice(at);
  if (body[at - 1] === '@') at -= 1;
  let before = body.slice(0, at);
  if (before && !/\s$/.test(before)) before += ' ';
  const handle = `@${userId.toLowerCase()}`;
  const tail = after.startsWith(' ') ? after : ` ${after}`;
  return {
    body: `${before}${handle}${tail}`,
    cursor: before.length + handle.length + 1,
  };
}

// ----------------------------------------------------------------- Documents

/** 123's case_documents_file_ref_check (http.ts's FILE_REF_RE). */
const FILE_REF_RE = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$/;

export function validFileRef(ref: string): boolean {
  return FILE_REF_RE.test(ref);
}

// -------------------------------------------------------------------- Errors

/** Refusal code -> message key under CasePage. */
const TOOL_ERRORS: Record<string, string> = {
  OWNER_INVALID: 'tasks.errors.ownerInvalid',
  DUE_INVALID: 'tasks.errors.dueInvalid',
  TEMPLATE_NOT_FOUND: 'tasks.errors.templateNotFound',
  TASK_NOT_FOUND: 'tasks.errors.taskNotFound',
  FILE_REF_REQUIRED: 'documents.errors.fileRefRequired',
  FILE_REF_INVALID: 'documents.errors.fileRefInvalid',
  DOC_NOT_REQUIRED: 'documents.errors.docNotRequired',
  NOTE_EMPTY: 'notes.errors.empty',
  NOTE_TOO_LONG: 'notes.errors.tooLong',
  CONTACT_INCOMPLETE: 'bankContacts.errors.incomplete',
  TEXT_TOO_LONG: 'bankContacts.errors.tooLong',
  CASE_CLOSED: 'errors.caseClosed',
  NOT_ALLOWED: 'errors.notAllowed',
  CASE_NOT_FOUND: 'errors.notFound',
};

/** The CasePage message key for a failed tool write. */
export function toolErrorKey(status: number, code: unknown): string {
  if (typeof code === 'string' && TOOL_ERRORS[code]) return TOOL_ERRORS[code];
  if (status === 403) return 'errors.notAllowed';
  if (status === 404) return 'errors.notFound';
  return 'errors.unknown';
}
