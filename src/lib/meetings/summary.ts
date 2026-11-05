// The record of a meeting on /meetings/[id]: the attendance and notes
// responses as the screen uses them, and the small decisions around them.

import {
  attendanceCsv,
  type AttendanceCsvLabels,
  type AttendanceEntry,
} from './attendance';
import { NOTES_MAX } from './requests';
import { meetingDurationMs, type MeetingSummary } from './schedule';

export interface MeetingAttendanceData {
  /** First joined first. */
  entries: AttendanceEntry[];
  people: number;
  startedAt: string | null;
  endedAt: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

function parseEntry(raw: unknown): AttendanceEntry | null {
  if (!isObject(raw)) return null;
  const { user_id, first_joined_at, total_ms, seats } = raw;
  if (typeof user_id !== 'string' || typeof first_joined_at !== 'string') {
    return null;
  }
  return {
    userId: user_id,
    firstJoinedAt: first_joined_at,
    lastLeftAt: strOrNull(raw.last_left_at),
    totalMs: typeof total_ms === 'number' ? total_ms : 0,
    seats: typeof seats === 'number' ? seats : 1,
    removed: raw.removed === true,
  };
}

/** GET …/attendance, snake to camel; null when it is not that shape. */
export function parseAttendance(json: unknown): MeetingAttendanceData | null {
  if (!isObject(json) || !Array.isArray(json.attendance)) return null;
  const entries = json.attendance
    .map(parseEntry)
    .filter((e): e is AttendanceEntry => e !== null)
    .sort((a, b) => Date.parse(a.firstJoinedAt) - Date.parse(b.firstJoinedAt));
  const summary = isObject(json.summary) ? json.summary : {};
  return {
    entries,
    people:
      typeof summary.people === 'number' ? summary.people : entries.length,
    startedAt: strOrNull(summary.started_at),
    endedAt: strOrNull(summary.ended_at),
  };
}

/**
 * How long it really ran: from the first seat to the last, which is more
 * honest than the row's `ended_at`, since an automatic close can stamp
 * that late. Without a read to go on, the row's figure. Null when nobody
 * came: a meeting nobody attended did not last anything.
 */
export function meetingRanMs(
  attendance: MeetingAttendanceData | null,
  m: Pick<MeetingSummary, 'status' | 'endedAt' | 'scheduledStart' | 'createdAt'>
): number | null {
  if (attendance?.startedAt && attendance.endedAt) {
    const ms =
      Date.parse(attendance.endedAt) - Date.parse(attendance.startedAt);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (attendance && attendance.people === 0) return null;
  return meetingDurationMs(m);
}

/** The invitees who came and those who did not, each in invited order. */
export function groupInvited(
  inviteeUserIds: readonly string[],
  entries: readonly Pick<AttendanceEntry, 'userId'>[]
): { attended: string[]; noShow: string[] } {
  const came = new Set(entries.map((e) => e.userId));
  const invited = [...new Set(inviteeUserIds)];
  return {
    attended: invited.filter((id) => came.has(id)),
    noShow: invited.filter((id) => !came.has(id)),
  };
}

/** Times they came back: a first seat is joining, not rejoining. */
export const rejoinCount = (e: Pick<AttendanceEntry, 'seats'>) =>
  Math.max(0, e.seats - 1);

/** The file's text. The BOM is what stops Excel garbling non-Latin names. */
export function attendanceCsvText(
  entries: readonly AttendanceEntry[],
  nameOf: (userId: string) => string,
  labels: AttendanceCsvLabels
): string {
  return `﻿${attendanceCsv(entries, nameOf, labels)}`;
}

export function attendanceFileName(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'meeting'}-attendance.csv`;
}

// ---------------------------------------------------------------- notes

export interface MeetingNotes {
  body: string;
  /** 0 means there is no row yet. */
  version: number;
  /** May name a deleted login, or nobody: an unknown person either way. */
  updatedBy: string | null;
  updatedAt: string | null;
}

export const NO_NOTES: MeetingNotes = {
  body: '',
  version: 0,
  updatedBy: null,
  updatedAt: null,
};

function parseNotes(raw: unknown): MeetingNotes {
  if (!isObject(raw) || typeof raw.body !== 'string') return NO_NOTES;
  return {
    body: raw.body,
    version: typeof raw.version === 'number' ? raw.version : 0,
    updatedBy: strOrNull(raw.updated_by),
    updatedAt: strOrNull(raw.updated_at),
  };
}

/** GET …/notes; null when it is not that shape. */
export function parseNotesRead(
  json: unknown
): { available: boolean; notes: MeetingNotes } | null {
  if (!isObject(json) || typeof json.available !== 'boolean') return null;
  return { available: json.available, notes: parseNotes(json.notes) };
}

export type NotesSaveOutcome =
  | { kind: 'saved'; notes: MeetingNotes }
  | { kind: 'stale'; latest: MeetingNotes }
  | { kind: 'closed' }
  | { kind: 'tooLong' }
  | { kind: 'failed' };

/** What a PUT …/notes answered, given the text that was sent. */
export function notesSaveOutcome(
  status: number,
  json: unknown,
  body: string
): NotesSaveOutcome {
  const r = isObject(json) ? json : {};
  if (status >= 200 && status < 300 && typeof r.version === 'number') {
    return { kind: 'saved', notes: parseNotes({ ...r, body }) };
  }
  if (status === 409 && r.error === 'stale') {
    return { kind: 'stale', latest: parseNotes(r.notes) };
  }
  if (status === 409 && r.error === 'meeting_closed') return { kind: 'closed' };
  if (status === 400) return { kind: 'tooLong' };
  return { kind: 'failed' };
}

/** The server's limit, which counts code points. */
export const notesTooLong = (body: string) =>
  Array.from(body).length > NOTES_MAX;
