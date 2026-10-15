# Calendar

The staff calendar: one screen that shows a person's own events, the
events they are invited to, scheduled video meetings and their tasks
with a due date. Events live in `calendar_events` and
`calendar_event_attendees` (migration 108); meetings and tasks are read
from their own tables and merged into the same feed
(`GET /api/calendar/feed`).

Staff only. Every policy goes through `current_account_id()`, which is
NULL for a bank guest, so a guest sees and writes nothing here; the
routes refuse a guest with 403 _The calendar is for staff only_.

## Who sees an event

In the caller's active workspace: the creator, every attendee, anyone in
the workspace when the event's visibility is `workspace`, and owners and
admins unless it is `private`. A GET of an event the caller cannot see
answers 404.

## Who can edit

**An event is edited and deleted by its creator (the organiser) only,
admins included.** The attendee list belongs to the organiser too. The
API refuses anyone else with 403 _Only the organiser can change this
event_; the database refuses them as well (RLS), so a direct write
changes nothing either.

**Meetings** keep their own rules (`docs/meetings.md`): the host edits a
meeting (title, time, invitees); owners and admins can still end or
cancel one, but not edit it. The calendar only shows them.

## Invitations and answers

Adding someone to an event inserts their attendee row as `pending` and
rings them a `calendar_invite` bell. They answer with
`PUT /api/calendar/events/[id]/response` (`accepted`, `tentative`,
`declined`), which rings the organiser (`calendar_response`). An
attendee may change only their own answer and reminders.

Changing an event's title, time, place or repeat rule rings every
attendee (`calendar_update`); cancelling or deleting it rings them
`calendar_cancelled`. Removing someone from the list deletes their row.

## Reminders

Rung as bells by the automations cron (`GET /api/automations/cron`, at
most once a minute per process):

- **Events**: the event's own reminders (minutes before the start, up
  to 5), or an attendee's own choice in place of them. Someone who
  declined is not reminded.
- **Meetings**: 10 minutes before the scheduled start, and at the start.
- **Tasks**: 15 minutes before the due time (`task_due`), to the
  assignee.

The SQL sweep (`calendar_reminder_sweep`) covers one-off events,
meetings and tasks; occurrences of a recurring event are computed in
the app (`runRecurringReminders`). Both record what they rang in
`calendar_reminders_sent`, so a reminder rings once even when the cron
runs twice.

## Recurring events

A repeating event is one row with an RFC 5545 repeat rule (daily,
weekly, monthly, yearly; an end date or a count), expanded in the app,
never stored per occurrence. When the organiser changes or deletes one
occurrence they choose:

- **This event**: a delete adds the occurrence's original start to the
  series' exceptions (`exdates`). A change makes a standalone copy of
  the occurrence with the change applied (same attendees, asked again
  as `pending`) and then adds the exception; if the exception cannot be
  written the copy is removed, so the occurrence is never lost.
- **All events**: the series row itself is changed or deleted. Moving
  the series (a new start time or time zone) moves its exceptions by
  the same wall-clock amount, so a skipped "Tuesday 09:00" stays
  skipped.

Every write of the exceptions checks that the series was not saved by
someone else in the meantime; if it was, the API answers 409 _This
event was changed by someone else; reload_.

## Time zones

Each event carries an IANA time zone (for example `Asia/Dubai`) and is
stored as instants. A repeating event repeats by the wall clock of its
own zone, so a weekly 09:00 in London stays 09:00 across a daylight
saving change. An all-day event is a day in its zone. The screen shows
everything in the viewer's zone.

## API

| Method | Path                                 | Body / query                                                              | Answer                                                                 |
| ------ | ------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/calendar/feed`                 | `from`, `to`                                                              | the merged feed                                                        |
| POST   | `/api/calendar/events`               | event fields, `attendees`                                                 | 201 `{ event, attendees }`                                             |
| GET    | `/api/calendar/events/[id]`          |                                                                           | `{ event, attendees: [{ user_id, response, responded_at }], canEdit }` |
| PATCH  | `/api/calendar/events/[id]`          | changed fields, `attendees?`, `scope?: 'this'\|'all'`, `occurrenceStart?` | `{ event }` (the row, or the new copy for `this`)                      |
| DELETE | `/api/calendar/events/[id]`          | `?scope=this\|all&occurrenceStart=ISO`                                    | `{ ok: true }`                                                         |
| PUT    | `/api/calendar/events/[id]/response` | `{ response, reminders? }`                                                | `{ ok: true, response }`                                               |

`start`, `end`, `allDay` and `timeZone` are always sent together.
Errors are `{ error }`: 400 invalid input, 403 not the organiser, 404
not visible, 409 changed elsewhere.
