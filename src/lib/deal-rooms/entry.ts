/**
 * Deal rooms outside team chat (module 014c, migration 088): the
 * customer page, a pipeline deal and the inbox contact panel each list
 * the rooms on their contact or deal and offer "New deal room". Pure, so
 * the rules are tested without a DOM; `deal_room_create` and the
 * `deal_rooms_read` policy stay the judges of what the caller may do.
 */

import {
  hasMinRole,
  isAccountRole,
  isBankGuest,
  type AccountRole,
} from '@/lib/auth/roles';

/** True with a Meta number on the account, null while still loading. */
export function hasMetaNumber(
  numbers: ReadonlyArray<{ provider: string }> | null
): boolean | null {
  if (numbers === null) return null;
  return numbers.some((n) => n.provider === 'meta');
}

export interface DealRoomEntry {
  /** Ask for the rooms at all. */
  load: boolean;
  /** Show the block. */
  show: boolean;
  /** Offer "New deal room". */
  create: boolean;
}

const NONE: DealRoomEntry = { load: false, show: false, create: false };

/**
 * Whether a screen shows its deal-room block. Never for a bank guest
 * (they reach rooms only from team chat) or an unknown role, and only
 * on a workspace with a Meta number, because only the Cloud API can
 * create a group; `metaNumber` null (still loading) shows nothing yet.
 * Agents and up may create (`deal_room_create` refuses rank < 2); a
 * viewer sees the block only when RLS hands them a room, since there
 * is nothing they could do with an empty one.
 */
export function dealRoomEntry(input: {
  accountRole: AccountRole | string | null;
  metaNumber: boolean | null;
  /** Rooms the caller can see here; null while loading. */
  rooms: number | null;
}): DealRoomEntry {
  const { accountRole, metaNumber, rooms } = input;
  if (!isAccountRole(accountRole) || isBankGuest(accountRole)) return NONE;
  if (metaNumber !== true) return NONE;
  const create = hasMinRole(accountRole, 'agent');
  return { load: true, show: create || (rooms ?? 0) > 0, create };
}

/** Whose rooms a block lists: one contact's or one deal's. */
export type RoomScope = { contactId: string } | { dealId: string };

/** The `GET /api/deal-rooms` query for a scope. */
export function roomScopeQuery(scope: RoomScope): string {
  return 'dealId' in scope
    ? `dealId=${encodeURIComponent(scope.dealId)}`
    : `contactId=${encodeURIComponent(scope.contactId)}`;
}

/** The realtime filter that signals a change to a scope's rooms. */
export function roomScopeFilter(scope: RoomScope): string {
  return 'dealId' in scope
    ? `deal_id=eq.${scope.dealId}`
    : `contact_id=eq.${scope.contactId}`;
}

export interface DealRoomContact {
  id: string;
  name: string | null;
  phone: string | null;
  company: string | null;
}

export interface DealRoomDeal {
  id: string;
  title: string | null;
}

/**
 * A pipeline deal's prefill for the create dialog: its contact and the
 * deal itself. Null when the contact was deleted (`contact_id` is SET
 * NULL then), because a room needs a contact.
 */
export function prefillFromDeal(deal: {
  id: string;
  title: string | null;
  contact_id: string | null;
  contact?: {
    name?: string | null;
    phone?: string | null;
    company?: string | null;
  } | null;
}): { contact: DealRoomContact; deal: DealRoomDeal } | null {
  if (!deal.contact_id) return null;
  return {
    contact: {
      id: deal.contact_id,
      name: deal.contact?.name ?? null,
      phone: deal.contact?.phone ?? null,
      company: deal.contact?.company ?? null,
    },
    deal: { id: deal.id, title: deal.title },
  };
}
