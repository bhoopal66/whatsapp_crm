// ============================================================
// Reminder suggestion chip (migration 197): what the inbox shows under
// a message. Pure and client-safe: no server imports.
// ============================================================

import { MIN_CUSTOM_LEAD_MS } from '@/lib/tasks/reminder';
import { TASK_NOTE_MAX } from '@/lib/tasks/types';
import type { ReminderKind, ReminderSuggestion } from '@/lib/reminders/types';

export interface ReminderChip {
  state: 'open' | 'added';
  dueAt: Date;
  dateOnly: boolean;
  suggestionId: string;
  kind: ReminderKind;
}

/**
 * The chip for a message's suggestion, or null: none, dismissed, or an
 * open one too close (≤ MIN_CUSTOM_LEAD_MS) or past to file as a task.
 * Added counts only while its task exists; a deleted task (task_id
 * NULL again) makes it open.
 */
export function chipFor(
  s: ReminderSuggestion | undefined,
  now: number
): ReminderChip | null {
  if (!s || s.status === 'dismissed') return null;
  const dueAt = new Date(s.due_at);
  if (Number.isNaN(dueAt.getTime())) return null;
  const base = {
    dueAt,
    dateOnly: s.date_only,
    suggestionId: s.id,
    kind: s.kind,
  };
  if (s.status === 'added' && s.task_id) return { state: 'added', ...base };
  if (dueAt.getTime() - now <= MIN_CUSTOM_LEAD_MS) return null;
  return { state: 'open', ...base };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today 15:00", "Tomorrow 09:00", else e.g. "Tue 18 Nov, 10:00"
 * (locale-formatted), all in the browser's local time.
 */
export function chipWhenLabel(
  dueAt: Date,
  now: Date,
  locale: string,
  words: { today: string; tomorrow: string }
): string {
  const time = dueAt.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (sameLocalDay(dueAt, now)) return `${words.today} ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameLocalDay(dueAt, tomorrow)) return `${words.tomorrow} ${time}`;
  return dueAt.toLocaleString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

const TITLE_KEYS = {
  call: 'titleCall',
  documents: 'titleDocuments',
  payment: 'titlePayment',
  meeting: 'titleMeeting',
  follow_up: 'titleFollowUp',
} as const satisfies Record<ReminderKind, string>;

export type ReminderTitleKey = (typeof TITLE_KEYS)[ReminderKind];

/** The `Inbox.reminderSuggestion` key for the task title of a kind. */
export function reminderTitleKey(kind: ReminderKind): ReminderTitleKey {
  return TITLE_KEYS[kind];
}

/**
 * The task note: the message text in quotes, whitespace collapsed,
 * clipped with "…" to fit TASK_NOTE_MAX. Empty text gives ''.
 */
export function reminderNote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = Array.from(flat);
  const room = TASK_NOTE_MAX - 2; // the two quotes
  const body =
    chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : flat;
  return `"${body}"`;
}

/** A realtime INSERT/UPDATE: the row replaces its message's entry. */
export function withSuggestion(
  map: ReadonlyMap<string, ReminderSuggestion>,
  row: ReminderSuggestion
): Map<string, ReminderSuggestion> {
  const next = new Map(map);
  next.set(row.message_id, row);
  return next;
}

/** A realtime DELETE (the payload carries only the id). */
export function withoutSuggestion(
  map: ReadonlyMap<string, ReminderSuggestion>,
  id: string
): Map<string, ReminderSuggestion> {
  const next = new Map(map);
  for (const [messageId, s] of next) {
    if (s.id === id) next.delete(messageId);
  }
  return next;
}

export type SuggestionActionOutcome = 'ok' | 'conflict' | 'failed';

/**
 * What an answer of POST /api/inbox/reminder-suggestions/[id] means
 * for the inbox. A 2xx is 'ok' and a 409 'conflict' (someone acted
 * first); both carry the row as it now stands, to merge (a conflict
 * silently). Anything else, or no answer (status null), is 'failed'
 * with nothing to merge.
 */
export function suggestionActionResult(
  status: number | null,
  body: unknown
): { outcome: SuggestionActionOutcome; suggestion: ReminderSuggestion | null } {
  const outcome: SuggestionActionOutcome =
    status !== null && status >= 200 && status < 300
      ? 'ok'
      : status === 409
        ? 'conflict'
        : 'failed';
  if (outcome === 'failed') return { outcome, suggestion: null };
  const row =
    body && typeof body === 'object'
      ? (body as { suggestion?: unknown }).suggestion
      : null;
  const valid =
    !!row &&
    typeof row === 'object' &&
    typeof (row as ReminderSuggestion).id === 'string' &&
    typeof (row as ReminderSuggestion).message_id === 'string' &&
    typeof (row as ReminderSuggestion).conversation_id === 'string';
  return { outcome, suggestion: valid ? (row as ReminderSuggestion) : null };
}
