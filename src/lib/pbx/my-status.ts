// ============================================================
// "My status" on the Calls screen: the status a person picks for their
// own extension, as Linkus offered it (PUT /api/pbx/me/presence). Pure
// and client-safe; see __tests__/my-status.test.ts.
//
// The list is restated from yeastar/events.ts (PRESENCE_STATUSES), which
// is not imported here so that the browser bundle does not pull the
// event parser in; my-status.test.ts keeps the two equal.
// ============================================================

import { presenceView, type PresenceView } from './presence';

export const MY_STATUSES = [
  'available',
  'away',
  'business_trip',
  'do_not_disturb',
  'lunch',
  'off_work',
] as const;
export type MyStatus = (typeof MY_STATUSES)[number];

export const isMyStatus = (v: unknown): v is MyStatus =>
  typeof v === 'string' && (MY_STATUSES as readonly string[]).includes(v);

/** The message key under `CallsPage.status`. */
export const MY_STATUS_KEY = {
  available: 'available',
  away: 'away',
  business_trip: 'businessTrip',
  do_not_disturb: 'dnd',
  lunch: 'lunch',
  off_work: 'offWork',
} as const satisfies Record<MyStatus, string>;

/** How the dots show a status (presenceView, with no call). */
export const statusView = (status: MyStatus): PresenceView =>
  presenceView(
    {
      user_id: null,
      extension: '',
      presence: status,
      call_state: null,
      updated_at: '',
    },
    0
  );

/** The status shown for a live view that disagrees with the one held. */
const VIEW_STATUS: Record<Exclude<PresenceView, 'on_call'>, MyStatus> = {
  available: 'available',
  away: 'away',
  dnd: 'do_not_disturb',
  off_work: 'off_work',
};

/**
 * The status the selector holds: the last one read or chosen, and the
 * live phone view seen at that moment (undefined: none yet).
 */
export interface HeldStatus {
  status: MyStatus | null;
  viewAt: PresenceView | undefined;
}

/**
 * What the selector shows, given the live view of my own extension
 * (usePhonePresence). The live view is coarser than a status (lunch and
 * business trip both read as away), so it is believed only once it has
 * moved since the held status was read or chosen, and only where it
 * disagrees with it: then the status was changed elsewhere (the desk
 * phone, Linkus, the PBX), and the view's own status stands in. A call
 * says nothing about the chosen status. A choice not yet echoed back by
 * the phone (the view has not moved) keeps showing the choice.
 */
export function shownStatus(
  held: HeldStatus,
  view: PresenceView | undefined
): MyStatus | null {
  if (view === undefined || view === held.viewAt || view === 'on_call')
    return held.status;
  if (held.status !== null && statusView(held.status) === view)
    return held.status;
  return VIEW_STATUS[view];
}
