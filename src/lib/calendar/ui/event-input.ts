import type { EventInput } from '@fullcalendar/core';

import type { FeedItem } from '../feed';
import { colorVar, safeColor } from './colors';
import { itemKey } from './item-time';

/** What every rendered event carries back to the callbacks. */
export interface CalendarEventProps {
  item: FeedItem;
}

/**
 * Whether the person may drag or resize this item. Events and meetings
 * follow the server's `editable`; tasks are never moved on the calendar
 * (their due date is edited on the task itself).
 */
export function isItemEditable(item: FeedItem): boolean {
  if (item.kind === 'task') return false;
  return item.editable === true;
}

/** Cancelled meetings are left off the calendar. */
export function isItemHidden(item: FeedItem): boolean {
  return item.kind === 'meeting' && item.status === 'cancelled';
}

export function itemClassNames(item: FeedItem): string[] {
  const out = ['cal-ev', `cal-ev--${item.kind}`];
  if (item.kind === 'event') {
    if (item.myResponse === 'declined') out.push('cal-ev--declined');
    if (item.myResponse === 'pending') out.push('cal-ev--pending');
    if (item.myResponse === 'tentative') out.push('cal-ev--tentative');
  }
  return out;
}

export function feedItemToEventInput(item: FeedItem): EventInput | null {
  if (isItemHidden(item)) return null;
  const color = safeColor(item.color);
  const props: CalendarEventProps = { item };
  return {
    id: itemKey(item),
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    editable: isItemEditable(item),
    classNames: itemClassNames(item),
    backgroundColor: colorVar(color, 'soft'),
    borderColor: colorVar(color, 'solid'),
    textColor: 'var(--foreground)',
    extendedProps: props,
  };
}

export function feedItemsToEventInputs(
  items: readonly FeedItem[]
): EventInput[] {
  const out: EventInput[] = [];
  for (const item of items) {
    const input = feedItemToEventInput(item);
    if (input) out.push(input);
  }
  return out;
}
