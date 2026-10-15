import type { AttendeeResponse } from '@/lib/calendar/feed';
import type { SeriesRow } from '@/lib/calendar/ui/drag';

/** GET /api/calendar/events/[id]. */
export interface EventDetail {
  event: SeriesRow & {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    color: string;
    rrule: string | null;
    exdates: string[] | null;
    visibility: string;
    reminders: number[] | null;
    status: string;
    created_by: string;
    updated_at: string;
  };
  attendees: {
    user_id: string;
    response: AttendeeResponse;
    responded_at: string | null;
  }[];
  canEdit: boolean;
}

/**
 * JSON in and out; a non-2xx throws the route's `{ error }` text, with
 * the HTTP status on the error (`errorStatus`).
 */
export async function calendarFetch<T>(
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers:
      init.body === undefined
        ? undefined
        : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!res.ok) {
    const error = typeof data?.error === 'string' ? data.error : null;
    throw Object.assign(new Error(error ?? `HTTP ${res.status}`), {
      status: res.status,
    });
  }
  return data as T;
}

export const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The HTTP status a `calendarFetch` error carries, else null. */
export const errorStatus = (err: unknown): number | null => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
};
