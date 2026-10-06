// ============================================================
// The timestamp on a conversation-list row, written the way WhatsApp
// writes it: the time for today, "Yesterday", the weekday within the
// last week, and the date beyond that.
//
// It replaced `formatDistanceToNow` ("about 2 hours", "3 days"), which
// gave every row a different length and phrasing, so the column could
// not be scanned. Pure, so the day boundaries are testable.
// ============================================================

import { differenceInCalendarDays, format } from 'date-fns';

export interface ListTimestampLabels {
  /** BCP 47 locale for the weekday name (the app's build-time locale). */
  locale: string;
  /** The catalogue's word for "Yesterday". */
  yesterday: string;
}

/**
 * Format `iso` relative to `now`, both in the viewer's local time.
 * Returns '' for a missing or unparseable timestamp. A stamp slightly
 * in the future (clock skew between the browser and the database)
 * still reads as today's time.
 */
export function formatListTimestamp(
  iso: string | null | undefined,
  now: Date,
  labels: ListTimestampLabels
): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const daysAgo = differenceInCalendarDays(now, date);
  if (daysAgo <= 0) return format(date, 'HH:mm');
  if (daysAgo === 1) return labels.yesterday;
  if (daysAgo < 7) {
    return new Intl.DateTimeFormat(labels.locale, { weekday: 'long' }).format(
      date
    );
  }
  return format(date, 'dd/MM/yyyy');
}
