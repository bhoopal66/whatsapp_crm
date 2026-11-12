// ============================================================
// The body of POST /api/inbox/reminder-suggestions/[id] (migration 197).
//
// Dependency-free apart from the shared shapes, so the inbox can import
// it to build the request it sends.
// ============================================================

import type { ReminderSuggestionAction } from '@/lib/reminders/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedReminderSuggestionAction =
  { ok: true; value: ReminderSuggestionAction } | { ok: false; error: string };

/**
 * `{ action: 'added', taskId }` (taskId a uuid), `{ action: 'dismissed' }`
 * or `{ action: 'reopen' }`; anything else is an error.
 */
export function parseReminderSuggestionAction(
  body: unknown
): ParsedReminderSuggestionAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'added':
      if (typeof b.taskId !== 'string' || !UUID.test(b.taskId)) {
        return { ok: false, error: 'taskId must be a task id.' };
      }
      return { ok: true, value: { action: 'added', taskId: b.taskId } };
    case 'dismissed':
      return { ok: true, value: { action: 'dismissed' } };
    case 'reopen':
      return { ok: true, value: { action: 'reopen' } };
    default:
      return {
        ok: false,
        error: "action must be 'added', 'dismissed' or 'reopen'.",
      };
  }
}
