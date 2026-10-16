/**
 * When the day and week grids scroll themselves to "now".
 *
 * FullCalendar's own `scrollTimeReset` re-scrolls the grid every time it
 * builds a new date profile, and it builds one for far more than a change
 * of dates: a new time zone (the workspace's arrives after first paint)
 * or any option that rebuilds its DateEnv. A re-scroll after the user has
 * scrolled to an event and clicked it moves the event out from under its
 * popover, so the click is undone. The calendar turns that reset off and
 * scrolls only when the visible dates themselves changed.
 */

/** The time a day/week grid opens at: an hour before now in `zone`. */
export function gridScrollTime(zone: string, nowMs: number): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(nowMs)
  );
  return `${String(Math.max(0, hour - 1)).padStart(2, '0')}:00:00`;
}

/**
 * What a `datesSet` shows: the view and the wall dates of its range in
 * the calendar's own zone (FullCalendar's `startStr`/`endStr` begin with
 * them), so the same week re-delivered in a new zone is the same key.
 */
export function datesKey(
  viewType: string,
  startStr: string,
  endStr: string
): string {
  return `${viewType}|${startStr.slice(0, 10)}|${endStr.slice(0, 10)}`;
}

/** Scroll to now only when the dates on screen changed (or first show). */
export function shouldScrollToNow(
  lastKey: string | null,
  key: string
): boolean {
  return lastKey !== key;
}
