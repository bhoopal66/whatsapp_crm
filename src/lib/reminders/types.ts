// ============================================================
// Reminder suggestions (migration 197, docs/jev-insights.md "Reminder
// suggestions"): the shapes the server and the inbox share.
//
// A chat message that names a later time ("call me tomorrow at 3",
// "I'll send the papers on Sunday") gets one suggestion row. Jev decides
// whether it is something to be reminded of and which of the times the
// message names is meant; the inbox shows "Add reminder" under the
// message, and adding it files the same follow-up task as the chat
// header's "Remind me" (lib/tasks/reminder.ts), which is on the calendar.
//
// Dependency-free on purpose: a client component imports it.
// ============================================================

/** Who wrote the message. 197's CHECK. */
export const REMINDER_SIDES = ['customer', 'agent'] as const;
export type ReminderSide = (typeof REMINDER_SIDES)[number];

/** What the reminder is about, as Jev judged it. 197's CHECK. */
export const REMINDER_KINDS = [
  'call',
  'documents',
  'payment',
  'meeting',
  'follow_up',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** 197's CHECK. */
export const REMINDER_SUGGESTION_STATUSES = [
  'open',
  'added',
  'dismissed',
] as const;
export type ReminderSuggestionStatus =
  (typeof REMINDER_SUGGESTION_STATUSES)[number];

/** A `message_reminder_suggestions` row as PostgREST returns it. */
export interface ReminderSuggestion {
  id: string;
  account_id: string;
  conversation_id: string;
  message_id: string;
  side: ReminderSide;
  kind: ReminderKind;
  /** The instant meant (ISO). */
  due_at: string;
  /** The message gave a day but no time of day: due_at is 09:00 local. */
  date_only: boolean;
  /** The words of the message that name the time (at most 120 chars). */
  phrase: string;
  /** Jev's probability that this is something to be reminded of. */
  p: number;
  status: ReminderSuggestionStatus;
  /** The follow-up task it became; NULL again if that task is deleted. */
  task_id: string | null;
  /** auth user id of the person who added or dismissed it. */
  acted_by: string | null;
  acted_at: string | null;
  created_at: string;
}

export const REMINDER_SUGGESTION_COLUMNS =
  'id, account_id, conversation_id, message_id, side, kind, due_at, date_only, phrase, p, status, task_id, acted_by, acted_at, created_at';

/** The body of POST /api/inbox/reminder-suggestions/[id]. */
export type ReminderSuggestionAction =
  | { action: 'added'; taskId: string }
  | { action: 'dismissed' }
  | { action: 'reopen' };
