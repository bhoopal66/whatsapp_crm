// ============================================================
// Recurring event reminders (migration 108).
//
// SQL rings one-off events itself; a series' occurrences exist only
// once expanded, so this finds the due (occurrence, offset, person)
// tuples and hands each to calendar_insert_reminder, which re-checks
// everything and rings each key at most once. A reminder is due when
// occurrence start - offset falls in (now - 5 min, now], the same
// window as the SQL sweep. The cron must never fail on this: errors
// are logged and the count of reminders rung is returned.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { expandEvent } from './recurrence';
import type { AttendeeResponse } from './feed';

/** How far back a reminder is still rung, matching the SQL sweep. */
export const REMINDER_WINDOW_MS = 5 * 60_000;
/** The longest reminder offset (28 days, 108's CHECK). */
export const MAX_OFFSET_MINUTES = 40320;
/** Series read per page (keyset on id). */
export const RECURRING_PAGE_SIZE = 500;
/** Series read per pass at most; hitting it is logged. */
export const RECURRING_MAX_ROWS = 20_000;

export interface ReminderEventRow {
  id: string;
  created_by: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  rrule: string | null;
  exdates: string[] | null;
  reminders: number[] | null;
  status: string;
}

export interface ReminderAttendeeRow {
  event_id: string;
  user_id: string;
  response: AttendeeResponse;
  /** NULL means the event's reminders. */
  reminders: number[] | null;
}

export interface DueReminder {
  key: string;
  userId: string;
  eventId: string;
  /** The occurrence's original start (ISO). */
  occurrenceStart: string;
  /** Minutes before the start. */
  offset: number;
}

export function reminderKey(
  eventId: string,
  occurrenceStartMs: number,
  offset: number,
  userId: string
): string {
  return `ev:${eventId.toLowerCase()}:${Math.floor(occurrenceStartMs / 1000)}:${offset}:${userId.toLowerCase()}`;
}

export function dueRecurringReminders(input: {
  events: readonly ReminderEventRow[];
  attendeeRows: readonly ReminderAttendeeRow[];
  now: number;
}): DueReminder[] {
  const { now } = input;
  const byEvent = new Map<string, ReminderAttendeeRow[]>();
  for (const a of input.attendeeRows) {
    const list = byEvent.get(a.event_id) ?? [];
    list.push(a);
    byEvent.set(a.event_id, list);
  }

  const out: DueReminder[] = [];
  for (const ev of input.events) {
    if (!ev.rrule || ev.status !== 'confirmed') continue;
    const people: { userId: string; offsets: number[] }[] = [
      { userId: ev.created_by, offsets: ev.reminders ?? [] },
    ];
    for (const a of byEvent.get(ev.id) ?? []) {
      if (a.response === 'declined' || a.user_id === ev.created_by) continue;
      people.push({
        userId: a.user_id,
        offsets: a.reminders ?? ev.reminders ?? [],
      });
    }
    const maxOffset = Math.max(-1, ...people.flatMap((p) => p.offsets));
    if (maxOffset < 0) continue;

    const { occurrences } = expandEvent(
      ev,
      now - REMINDER_WINDOW_MS,
      now + maxOffset * 60_000 + 1
    );
    for (const o of occurrences) {
      for (const p of people) {
        for (const offset of new Set(p.offsets)) {
          const ringAt = o.start - offset * 60_000;
          if (ringAt <= now - REMINDER_WINDOW_MS || ringAt > now) continue;
          out.push({
            key: reminderKey(ev.id, o.start, offset, p.userId),
            userId: p.userId,
            eventId: ev.id,
            occurrenceStart: new Date(o.start).toISOString(),
            offset,
          });
        }
      }
    }
  }
  return out;
}

type EventWithAttendees = ReminderEventRow & {
  calendar_event_attendees: Omit<ReminderAttendeeRow, 'event_id'>[] | null;
};

/**
 * One pass over every confirmed series (service role). Never throws;
 * returns how many reminders rang.
 */
export async function runRecurringReminders(
  admin: SupabaseClient,
  now: Date = new Date()
): Promise<number> {
  const nowMs = now.getTime();
  // Only series that can still ring: started no later than the longest
  // offset ahead, and not ended before the window (series_end_at is
  // NULL for an open-ended series). Paged by id so none is skipped.
  const due: DueReminder[] = [];
  let lastId: string | null = null;
  let read = 0;
  for (;;) {
    let rows: EventWithAttendees[];
    try {
      let q = admin
        .from('calendar_events')
        .select(
          'id, created_by, start_at, end_at, all_day, time_zone, rrule, exdates, reminders, status, calendar_event_attendees(user_id, response, reminders)'
        )
        .eq('status', 'confirmed')
        .not('rrule', 'is', null)
        .lte(
          'start_at',
          new Date(nowMs + MAX_OFFSET_MINUTES * 60_000).toISOString()
        )
        .or(
          `series_end_at.is.null,series_end_at.gte.${new Date(nowMs - REMINDER_WINDOW_MS).toISOString()}`
        );
      if (lastId) q = q.gt('id', lastId);
      const { data, error } = await q.order('id').limit(RECURRING_PAGE_SIZE);
      if (error) throw error;
      rows = (data ?? []) as EventWithAttendees[];
    } catch (err) {
      console.error('[calendar] recurring reminders: read failed', err);
      break;
    }
    // One series at a time, so a row that will not expand costs only itself.
    for (const ev of rows) {
      try {
        due.push(
          ...dueRecurringReminders({
            events: [ev],
            attendeeRows: (ev.calendar_event_attendees ?? []).map((a) => ({
              ...a,
              event_id: ev.id,
            })),
            now: nowMs,
          })
        );
      } catch (err) {
        console.error(
          '[calendar] recurring reminders: cannot expand',
          ev.id,
          err
        );
      }
    }
    read += rows.length;
    if (rows.length < RECURRING_PAGE_SIZE) break;
    if (read >= RECURRING_MAX_ROWS) {
      console.error(
        '[calendar] recurring reminders: stopped at',
        RECURRING_MAX_ROWS,
        'series this pass'
      );
      break;
    }
    lastId = rows[rows.length - 1].id;
  }

  let rung = 0;
  for (const d of due) {
    try {
      const { data, error } = await admin.rpc('calendar_insert_reminder', {
        p_key: d.key,
        p_user: d.userId,
        p_event: d.eventId,
        p_occurrence_start: d.occurrenceStart,
        p_offset: d.offset,
      });
      if (error) throw error;
      if (data === true) rung++;
    } catch (err) {
      console.error('[calendar] recurring reminder failed', d.key, err);
    }
  }
  return rung;
}
