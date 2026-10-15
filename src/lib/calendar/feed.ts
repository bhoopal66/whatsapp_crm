// ============================================================
// Calendar feed (migration 108) — pure, no I/O.
//
// Merges the caller's visible events (expanded into occurrences),
// meetings and tasks over one range into a sorted list the calendar
// screen draws. RLS has already decided what the caller may see; this
// only shapes it. Declined invitations stay in (myResponse 'declined',
// the screen dims them) so a person can still change their mind.
// ============================================================

import { expandEvent, wallClock } from './recurrence';
import type { EventColor } from './validate';

export type AttendeeResponse =
  'pending' | 'accepted' | 'tentative' | 'declined';

export interface FeedEventRow {
  id: string;
  created_by: string;
  title: string;
  location: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  time_zone: string;
  color: EventColor;
  rrule: string | null;
  exdates: string[] | null;
  status: 'confirmed' | 'cancelled';
}

export interface FeedAttendeeRow {
  event_id: string;
  user_id: string;
  response: AttendeeResponse;
}

export interface FeedMeetingRow {
  id: string;
  title: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  host_user_id: string;
  status: string;
}

export interface FeedTaskRow {
  id: string;
  title: string;
  due_at: string | null;
  contact_id: string | null;
}

interface FeedItemBase {
  id: string;
  /** Identity of the instance: the occurrence's original start (ISO). */
  occurrenceStart: string;
  title: string;
  /** ISO instants; for an all-day event YYYY-MM-DD in its zone, end exclusive. */
  start: string;
  end: string;
  allDay: boolean;
  color: EventColor;
  editable: boolean;
}

export interface EventFeedItem extends FeedItemBase {
  kind: 'event';
  location: string | null;
  recurring: boolean;
  /** 'organizer' for the creator, their response for an invitee, null
   *  for a workspace-visible event they were not invited to. */
  myResponse: 'organizer' | AttendeeResponse | null;
  organizerId: string;
  /** Invitees, not counting the organiser. */
  attendeeCount: number;
}

export interface MeetingFeedItem extends FeedItemBase {
  kind: 'meeting';
  status: string;
}

export interface TaskFeedItem extends FeedItemBase {
  kind: 'task';
  contactId: string | null;
}

export type FeedItem = EventFeedItem | MeetingFeedItem | TaskFeedItem;

export interface BuildFeedInput {
  events: readonly FeedEventRow[];
  attendeeRows: readonly FeedAttendeeRow[];
  meetings: readonly FeedMeetingRow[];
  tasks: readonly FeedTaskRow[];
  /** The caller's auth user id. */
  me: string;
  fromMs: number;
  toMs: number;
}

/** A meeting with no scheduled end is drawn as 30 minutes. */
export const MEETING_DEFAULT_MS = 30 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
function dateIn(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Overlaps [from, to); a zero-length item counts when it starts inside. */
const overlaps = (start: number, end: number, from: number, to: number) =>
  start < to && (end > from || (end === start && start >= from));

export function buildFeed(input: BuildFeedInput): FeedItem[] {
  const { me, fromMs, toMs } = input;
  const byEvent = new Map<string, FeedAttendeeRow[]>();
  for (const a of input.attendeeRows) {
    const list = byEvent.get(a.event_id) ?? [];
    list.push(a);
    byEvent.set(a.event_id, list);
  }

  const items: { at: number; item: FeedItem }[] = [];
  const seen = new Set<string>();
  const push = (at: number, item: FeedItem) => {
    const key = `${item.kind}:${item.id}:${item.occurrenceStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ at, item });
  };

  for (const ev of input.events) {
    if (ev.status !== 'confirmed') continue;
    const invitees = (byEvent.get(ev.id) ?? []).filter(
      (a) => a.user_id !== ev.created_by
    );
    const mine = invitees.find((a) => a.user_id === me);
    const myResponse =
      ev.created_by === me ? 'organizer' : (mine?.response ?? null);
    for (const o of expandEvent(ev, fromMs, toMs).occurrences) {
      push(o.start, {
        kind: 'event',
        id: ev.id,
        occurrenceStart: iso(o.start),
        title: ev.title,
        start: ev.all_day ? dateIn(o.start, ev.time_zone) : iso(o.start),
        end: ev.all_day ? dateIn(o.end, ev.time_zone) : iso(o.end),
        allDay: ev.all_day,
        color: ev.color,
        editable: ev.created_by === me,
        location: ev.location,
        recurring: !!ev.rrule,
        myResponse,
        organizerId: ev.created_by,
        attendeeCount: invitees.length,
      });
    }
  }

  for (const m of input.meetings) {
    if (!m.scheduled_start) continue;
    const start = Date.parse(m.scheduled_start);
    const end = m.scheduled_end
      ? Date.parse(m.scheduled_end)
      : start + MEETING_DEFAULT_MS;
    if (!overlaps(start, end, fromMs, toMs)) continue;
    push(start, {
      kind: 'meeting',
      id: m.id,
      occurrenceStart: iso(start),
      title: m.title,
      start: iso(start),
      end: iso(end),
      allDay: false,
      color: 'violet',
      editable: m.host_user_id === me,
      status: m.status,
    });
  }

  for (const t of input.tasks) {
    if (!t.due_at) continue;
    const due = Date.parse(t.due_at);
    if (!overlaps(due, due, fromMs, toMs)) continue;
    push(due, {
      kind: 'task',
      id: t.id,
      occurrenceStart: iso(due),
      title: t.title,
      start: iso(due),
      end: iso(due),
      allDay: false,
      color: 'amber',
      editable: false,
      contactId: t.contact_id,
    });
  }

  // By start; at the same instant all-day first, then by title and id.
  return items
    .sort(
      (a, b) =>
        a.at - b.at ||
        Number(b.item.allDay) - Number(a.item.allDay) ||
        a.item.title.localeCompare(b.item.title) ||
        a.item.id.localeCompare(b.item.id)
    )
    .map((x) => x.item);
}
