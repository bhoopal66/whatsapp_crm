// ============================================================
// Meetings API — pure body validation and list helpers (no I/O).
// The limits mirror migration 106's CHECKs (title 1–200 trimmed,
// description ≤ 2000, end after start).
// ============================================================

import {
  MEETING_SCOPES,
  PRESENCE_WINDOW_MS,
  type MeetingRow,
  type MeetingScope,
} from './types';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const INVITEES_MAX = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 with an offset: a zoneless time means another moment elsewhere. */
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export type Parsed<T> = { ok: true; values: T } | { ok: false; error: string };

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export interface MeetingWriteValues {
  title?: string;
  description?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  open_to_workspace?: boolean;
}

type Field<T> = { ok: true; value: T } | { ok: false; error: string };

function title(raw: unknown): Field<string> {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return { ok: false, error: 'Title is required' };
  if (v.length > TITLE_MAX) {
    return {
      ok: false,
      error: `Title must be at most ${TITLE_MAX} characters`,
    };
  }
  return { ok: true, value: v };
}

function description(raw: unknown): Field<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Description must be text' };
  }
  const v = raw.trim();
  if (v.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `Description must be at most ${DESCRIPTION_MAX} characters`,
    };
  }
  return { ok: true, value: v || null };
}

function time(raw: unknown, label: string): Field<string | null> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (
    typeof raw !== 'string' ||
    !ISO_DATE_TIME_RE.test(raw) ||
    Number.isNaN(Date.parse(raw))
  ) {
    return {
      ok: false,
      error: `${label} must be an ISO date-time with an offset`,
    };
  }
  return { ok: true, value: new Date(raw).toISOString() };
}

function invitees(raw: unknown): Field<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || !raw.every(isUuid)) {
    return { ok: false, error: 'inviteeUserIds must be a list of user ids' };
  }
  const ids = [...new Set(raw.map((id) => id.toLowerCase()))];
  if (ids.length > INVITEES_MAX) {
    return { ok: false, error: `At most ${INVITEES_MAX} invitees` };
  }
  return { ok: true, value: ids };
}

/** Start and end as stored: an end needs a start and must come after it. */
export function checkTimeRange(
  start: string | null,
  end: string | null
): string | null {
  if (end && !start) return 'An end time needs a start time';
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    return 'The end time must be after the start time';
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** POST /api/meetings body. */
export function parseCreateMeeting(body: unknown): Parsed<{
  meeting: Required<MeetingWriteValues>;
  inviteeUserIds: string[];
}> {
  if (!isObject(body)) return { ok: false, error: 'Invalid request body' };
  const t = title(body.title);
  if (!t.ok) return t;
  const d = description(body.description);
  if (!d.ok) return d;
  const s = time(body.scheduledStart, 'scheduledStart');
  if (!s.ok) return s;
  const e = time(body.scheduledEnd, 'scheduledEnd');
  if (!e.ok) return e;
  const range = checkTimeRange(s.value, e.value);
  if (range) return { ok: false, error: range };
  if (
    body.openToWorkspace !== undefined &&
    typeof body.openToWorkspace !== 'boolean'
  ) {
    return { ok: false, error: 'openToWorkspace must be true or false' };
  }
  const inv = invitees(body.inviteeUserIds);
  if (!inv.ok) return inv;
  return {
    ok: true,
    values: {
      meeting: {
        title: t.value,
        description: d.value,
        scheduled_start: s.value,
        scheduled_end: e.value,
        open_to_workspace: body.openToWorkspace === true,
      },
      inviteeUserIds: inv.value,
    },
  };
}

/**
 * PATCH /api/meetings/[id] body. Only the keys sent change; the time
 * range is checked against `current` for the key left out.
 */
export function parseMeetingPatch(
  body: unknown,
  current: Pick<MeetingRow, 'scheduled_start' | 'scheduled_end'>
): Parsed<{ meeting: MeetingWriteValues; inviteeUserIds?: string[] }> {
  if (!isObject(body)) return { ok: false, error: 'Invalid request body' };
  const meeting: MeetingWriteValues = {};
  if ('title' in body) {
    const t = title(body.title);
    if (!t.ok) return t;
    meeting.title = t.value;
  }
  if ('description' in body) {
    const d = description(body.description);
    if (!d.ok) return d;
    meeting.description = d.value;
  }
  if ('scheduledStart' in body) {
    const s = time(body.scheduledStart, 'scheduledStart');
    if (!s.ok) return s;
    meeting.scheduled_start = s.value;
  }
  if ('scheduledEnd' in body) {
    const e = time(body.scheduledEnd, 'scheduledEnd');
    if (!e.ok) return e;
    meeting.scheduled_end = e.value;
  }
  if ('scheduledStart' in body || 'scheduledEnd' in body) {
    const range = checkTimeRange(
      meeting.scheduled_start !== undefined
        ? meeting.scheduled_start
        : current.scheduled_start,
      meeting.scheduled_end !== undefined
        ? meeting.scheduled_end
        : current.scheduled_end
    );
    if (range) return { ok: false, error: range };
  }
  if ('openToWorkspace' in body) {
    if (typeof body.openToWorkspace !== 'boolean') {
      return { ok: false, error: 'openToWorkspace must be true or false' };
    }
    meeting.open_to_workspace = body.openToWorkspace;
  }
  let inviteeUserIds: string[] | undefined;
  if ('inviteeUserIds' in body) {
    const inv = invitees(body.inviteeUserIds);
    if (!inv.ok) return inv;
    inviteeUserIds = inv.value;
  }
  if (Object.keys(meeting).length === 0 && inviteeUserIds === undefined) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, values: { meeting, inviteeUserIds } };
}

/** Rows to insert and delete to turn `current` into `next`. */
export function diffInvitees(
  current: readonly string[],
  next: readonly string[]
): { add: string[]; remove: string[] } {
  const have = new Set(current.map((id) => id.toLowerCase()));
  const want = new Set(next.map((id) => id.toLowerCase()));
  return {
    add: [...want].filter((id) => !have.has(id)),
    remove: current.filter((id) => !want.has(id.toLowerCase())),
  };
}

/** Present = not left, and a heartbeat within PRESENCE_WINDOW_MS. */
export function isPresent(
  p: { left_at: string | null; last_seen_at: string },
  now: number
): boolean {
  return (
    p.left_at === null && Date.parse(p.last_seen_at) > now - PRESENCE_WINDOW_MS
  );
}

/** The `last_seen_at` lower bound a presence query filters on. */
export function presenceCutoff(now: number): string {
  return new Date(now - PRESENCE_WINDOW_MS).toISOString();
}

export function parseScope(raw: string | null): MeetingScope | null {
  const v = raw ?? 'upcoming';
  return (MEETING_SCOPES as readonly string[]).includes(v)
    ? (v as MeetingScope)
    : null;
}

/**
 * Which tab a meeting belongs on. "Live" is derived, never stored: a
 * scheduled meeting with someone present. Ended/cancelled, or a scheduled
 * one whose end has passed with nobody in it, is past; the rest upcoming.
 */
export function meetingPhase(
  m: Pick<MeetingRow, 'status' | 'scheduled_end'>,
  presentCount: number,
  now: number
): MeetingScope {
  if (m.status !== 'scheduled') return 'past';
  if (presentCount > 0) return 'live';
  if (m.scheduled_end && Date.parse(m.scheduled_end) < now) return 'past';
  return 'upcoming';
}
