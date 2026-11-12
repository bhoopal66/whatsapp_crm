// The chat header's "Remind me": a follow-up task about this customer
// and this chat, due on a preset day at 09:00 local or at a picked
// time. Times are the browser's local clock; the task stores the
// instant (`toISOString()`), so whoever opens it later sees it in
// their own zone. A picked time is parsed by the call window's
// `parseCustomDueAt` (`lib/pbx/follow-up.ts`), which refuses the past.

import { canManageMembers, canSendMessages } from '@/lib/auth/roles';
import type { AccountRole } from '@/lib/auth/roles';
import { parseCustomDueAt } from '@/lib/pbx/follow-up';
import type { Task } from '@/lib/tasks/types';
import type { Profile } from '@/types';

export const REMINDER_PRESETS = [
  'tomorrow',
  'in1week',
  'in1month',
  'in3months',
] as const;
export type ReminderPreset = (typeof REMINDER_PRESETS)[number];

/** The local hour a preset day lands on. */
export const REMINDER_HOUR = 9;

/**
 * `months` after today's local date (clamped to the target month's
 * last day, so 31 January plus one month is 28/29 February, not
 * 3 March) plus `days`, at `REMINDER_HOUR`:00 local.
 */
function presetDay(now: Date, months: number, days: number): Date {
  const y = now.getFullYear();
  const m = now.getMonth() + months;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const d = Math.min(now.getDate(), lastDay) + days;
  return new Date(y, m, d, REMINDER_HOUR, 0, 0, 0);
}

/** When a preset falls due, counted from `now`. Always after `now`. */
export function reminderDueAt(preset: ReminderPreset, now: Date): Date {
  switch (preset) {
    case 'tomorrow':
      return presetDay(now, 0, 1);
    case 'in1week':
      return presetDay(now, 0, 7);
    case 'in1month':
      return presetDay(now, 1, 0);
    case 'in3months':
      return presetDay(now, 3, 0);
    default: {
      const never: never = preset;
      throw new Error(`Unknown reminder preset: ${String(never)}`);
    }
  }
}

/**
 * Who a reminder may be for: the people this person may already hand
 * the chat to (the header's `assignableProfiles`) who can hold a task
 * (agent and up, the tasks trigger's rule), the caller first.
 */
export function reminderAssignees(
  profiles: readonly Profile[],
  me: string | null
): Profile[] {
  const holders = profiles.filter(
    (p) =>
      !p.deactivated_at &&
      (p.user_id === me ||
        (!!p.account_role && canSendMessages(p.account_role)))
  );
  return [
    ...holders.filter((p) => p.user_id === me),
    ...holders.filter((p) => p.user_id !== me),
  ];
}

/**
 * The reminder sweep (migration 197) rings a task twice: a quiet
 * `task_due` heads-up 15 minutes before it is due, and the alarm when it
 * falls due. So a reminder only needs to be one sweep (at most a minute
 * or so) ahead of now to ring; this keeps a margin over that.
 */
export const MIN_CUSTOM_LEAD_MS = 2 * 60 * 1000;

export type CustomReminderDue =
  | { ok: true; at: Date }
  | { ok: false; reason: 'invalid' | 'past' | 'tooSoon' };

/** A picked time as an instant, at least 2 minutes after `now`. */
export function parseCustomReminderDue(
  value: string,
  now: Date
): CustomReminderDue {
  const r = parseCustomDueAt(value, now);
  if (!r.ok) return r;
  if (r.at.getTime() - now.getTime() < MIN_CUSTOM_LEAD_MS)
    return { ok: false, reason: 'tooSoon' };
  return r;
}

/** Which "saved" message to show: the caller's own, or a colleague's. */
export function savedToastKey(
  forId: string | null,
  me: string | null
): 'saved' | 'savedFor' {
  return forId && forId !== me ? 'savedFor' : 'saved';
}

export type UpcomingReminder = Pick<
  Task,
  'id' | 'title' | 'due_at' | 'assigned_to' | 'status' | 'created_by'
>;

/**
 * Whether the caller may mark a task done: its assignee, its creator,
 * or an owner/admin (the tasks update policy also lets the assignee's
 * leader, which the list cannot see).
 */
export function canMarkReminderDone(
  task: Pick<UpcomingReminder, 'assigned_to' | 'created_by'>,
  me: string | null,
  role: AccountRole | null
): boolean {
  if (me && (task.assigned_to === me || task.created_by === me)) return true;
  return !!role && canManageMembers(role);
}

/** The open, dated tasks of a list, soonest first. */
export function upcomingReminders<T extends UpcomingReminder>(
  tasks: readonly T[]
): T[] {
  return tasks
    .filter(
      (t) =>
        t.status === 'open' &&
        !!t.due_at &&
        Number.isFinite(Date.parse(t.due_at))
    )
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
}
