/**
 * `?date=YYYY-MM-DD&view=week` mirrors what the calendar shows, and
 * `?event=<id>` (from a notification) opens that item once loaded.
 */
export const VIEW_KEYS = ['day', 'week', 'month', 'year', 'agenda'] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

export const DEFAULT_VIEW: ViewKey = 'week';

/** Our view names → FullCalendar's. */
export const FC_VIEWS: Record<ViewKey, string> = {
  day: 'timeGridDay',
  week: 'timeGridWeek',
  month: 'dayGridMonth',
  year: 'multiMonthYear',
  agenda: 'listWeek',
};

export function viewKeyOf(fcView: string): ViewKey | null {
  const hit = VIEW_KEYS.find((k) => FC_VIEWS[k] === fcView);
  return hit ?? null;
}

export interface CalendarUrlState {
  date: string | null;
  view: ViewKey;
  eventId: string | null;
}

/** A real calendar date in 'YYYY-MM-DD' form, else null. */
export function parseDateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  return dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo &&
    dt.getUTCDate() === d
    ? value
    : null;
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

type ParamValue = string | string[] | null | undefined;
const first = (v: ParamValue) => (Array.isArray(v) ? v[0] : v);

/** Reads either URLSearchParams or a Next `searchParams` object. */
export function parseCalendarParams(
  params: URLSearchParams | Record<string, ParamValue>
): CalendarUrlState {
  const get = (k: string): string | null | undefined =>
    params instanceof URLSearchParams ? params.get(k) : first(params[k]);
  const view = get('view');
  const eventId = get('event');
  return {
    date: parseDateKey(get('date')),
    view: (VIEW_KEYS as readonly string[]).includes(view ?? '')
      ? (view as ViewKey)
      : DEFAULT_VIEW,
    eventId: eventId && EVENT_ID.test(eventId) ? eventId : null,
  };
}

/**
 * The query string for `state`, keeping any other parameters already
 * there. `event` is dropped once handled (eventId null).
 */
export function serialiseCalendarParams(
  current: string,
  state: CalendarUrlState
): string {
  const params = new URLSearchParams(current);
  if (state.date) params.set('date', state.date);
  else params.delete('date');
  params.set('view', state.view);
  if (state.eventId) params.set('event', state.eventId);
  else params.delete('event');
  return params.toString();
}
