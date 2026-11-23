// What the event popover offers whom — pure. The API decides; this
// only keeps the popover from offering what the API would refuse.

import { splitLinks, type ChatPart } from '@/lib/meetings/room-ui/chat';

import type { AttendeeResponse, FeedItem } from '../feed';

export interface EventDetailFacts {
  createdBy: string;
  /** The API's own `canEdit` (organiser only). */
  canEdit: boolean;
  /** The API's own `canDelete`: the organiser, or an admin for a leaver's
   *  event (278). */
  canDelete: boolean;
  attendees: readonly { user_id: string; response: AttendeeResponse }[];
}

export interface PopoverActions {
  /** Accept / Maybe / Decline. */
  rsvp: boolean;
  /** My response, when I am invited. */
  myResponse: AttendeeResponse | null;
  /** "Notify me": a reminder override, once I have answered. */
  notify: boolean;
  edit: boolean;
  remove: boolean;
  /** Edit and Delete ask "This event / All events" first. */
  askScope: boolean;
  join: boolean;
  /** `/meetings/<id>` and `/meetings/<id>/room`. */
  meetingId: string | null;
  /** `/contacts/<id>` for a task. */
  contactId: string | null;
}

const NONE: PopoverActions = {
  rsvp: false,
  myResponse: null,
  notify: false,
  edit: false,
  remove: false,
  askScope: false,
  join: false,
  meetingId: null,
  contactId: null,
};

/**
 * `detail` is the loaded event (null while loading or for meetings and
 * tasks). Edit needs the organiser on both counts: the API's `canEdit` and
 * the row's creator being me. Delete takes the API's `canDelete` too: an
 * admin may delete a leaver's event, never edit it.
 */
export function popoverActions(
  item: FeedItem,
  detail: EventDetailFacts | null,
  me: string | null
): PopoverActions {
  if (item.kind === 'task') return { ...NONE, contactId: item.contactId };
  if (item.kind === 'meeting') {
    const live = item.status !== 'ended' && item.status !== 'cancelled';
    return { ...NONE, join: live, meetingId: item.id };
  }
  if (!detail || !me) return NONE;
  const organiser = detail.canEdit && detail.createdBy === me;
  const remove = organiser || detail.canDelete;
  const mine = organiser
    ? null
    : (detail.attendees.find((a) => a.user_id === me) ?? null);
  return {
    ...NONE,
    rsvp: !!mine,
    myResponse: mine?.response ?? null,
    notify: !!mine && mine.response !== 'pending',
    edit: organiser,
    remove,
    askScope: remove && item.recurring,
  };
}

/** A description as text and safe http(s) links, for plain rendering. */
export function descriptionParts(text: string): ChatPart[] {
  return splitLinks(text);
}
