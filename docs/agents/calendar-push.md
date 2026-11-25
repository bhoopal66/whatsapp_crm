> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Calendar and web push (`lib/calendar/*`, `lib/push/*`, migrations 108–110)

`docs/calendar.md` and `docs/push.md` are the contracts.

- **Calendar** is staff only (`current_account_id()`, so a guest gets
  403). `GET /api/calendar/feed` merges `calendar_events` with meetings
  and dated tasks, which keep their own rules. Only the organiser edits
  an event, admins included. Deleting it, or cancelling one of its dates,
  is the organiser's too, and an owner's or admin's once the organiser is
  no longer live staff there (278, `calendar_event_row_removable`; never a
  private event). RLS enforces this as well as the API, whose GET answers
  `canDelete`. A recurring event is one row with an RFC 5545 rule, expanded in
  the app (`recurrence.ts`) and never stored per occurrence. "This
  event" edits go through `calendar_split_occurrence` /
  `calendar_cancel_occurrence`. Reminders ring once through
  `calendar_reminders_sent`. One-off events, meetings and tasks come
  from the SQL `calendar_reminder_sweep`, and recurring occurrences from
  `runRecurringReminders`.
- **Event bells (278).** A person taken off an event, or off one date of a
  series, is rung `calendar_cancelled` by the functions
  (`calendar_remove_attendees`, `calendar_ring_removed`), not by a DELETE
  trigger, so deleting an event rings once. An event that is over rings
  nobody; a series whose first date is past is "Repeating event …", with
  no date. 278 restates 108's two notify functions and patches 108's
  write functions in place: after re-running 106 or 108, run 278 again.
  `verify-calendar-meeting-bells.sql`.
- **Push** needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
  `VAPID_SUBJECT`. They are read at request time. If any is unset, the
  `/api/push/*` routes answer 503 `push_not_configured`. Writers queue
  into `push_outbox`. In production `src/instrumentation.ts` runs a
  delivery loop per process, and the automations cron makes a fallback
  pass. A leased claim keeps the two from double-sending. At claim time,
  a `chat_message` row whose message has been edited, deleted or erased
  is skipped (112). Quiet hours hold everything except meeting and event
  reminders.
- **Reminder rings (197).** `task_due` rings at 15 minutes and when due
  (`meta.offset`); the alarm card is `components/reminders/reminder-alarm.tsx`
  on `lib/reminders/alarm.ts`. Every push of one task carries tag
  `task:<id>` so a later ring replaces the last. `docs/calendar.md`.
- **Late rings (268).** Tasks ring up to 12 h late, events and meetings
  30 min and not after their end; a heads-up, event or meeting past its
  first 5 minutes only if it was set before its time. The sweep and
  `reminders.ts` state the same rules: change both.
- **Stale bells (319).** Triggers on `tasks`, `meetings` and
  `calendar_events` read a row's unread reminder bells when it is finished,
  moved, cancelled or deleted (an ended meeting keeps its bell), so every
  writer closes the alarm card. A new reminder type goes into the index, the
  triggers and `ALARM_TYPES`. Done on the card checks the task first
  (`stillDue`). `verify-stale-bells.sql`.
- **117** makes two meeting FKs `DEFERRABLE INITIALLY DEFERRED`, because
  a same-transaction insert-then-cascade-delete failed after a
  `pg_dump` restore. The migration explains why no other FK was
  changed. Add one only with a reproduction.
