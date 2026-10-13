/**
 * Deal rooms — what the members panel offers for adding people to a
 * room's channel (migrations 088, 096), kept apart from `people.ts`
 * (which reaches server modules) so the panel can import it. The
 * database still decides every add; this only hides what it refuses.
 */

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { addCandidates } from '@/lib/chat/membership';
import type { ChannelMember, ChatPerson } from '@/lib/chat/types';

/** The codes the panel words itself; `bank` rides along where it matters. */
export const ADD_PEOPLE_ERRORS = [
  'not_manager',
  'not_leader',
  'room_closed',
  'not_staff',
  'not_guest',
  'no_bank_participant',
  'bank_guests_off',
] as const;
export type AddPeopleError = (typeof ADD_PEOPLE_ERRORS)[number];

/** A refusal code the panel has its own wording for; null otherwise. */
export function addPeopleErrorKey(code: unknown): AddPeopleError | null {
  return (ADD_PEOPLE_ERRORS as readonly unknown[]).includes(code)
    ? (code as AddPeopleError)
    : null;
}

/**
 * Rooms that still take people. 088 refuses closing and closed; a
 * failed room never had a group, so nobody is offered there either.
 */
const ADDABLE_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'open',
  'suspended',
]);

export type AddPeopleKind = 'staff' | 'guest';

/**
 * What the panel offers: staff to any manager of the room, a bank
 * guest login to a manager who is a team leader or above (as
 * deal_room_add_staff / deal_room_add_guest_user check).
 */
export function addPeopleOptions(args: {
  canManage: boolean;
  status: string;
  role: AccountRole | null;
}): Record<AddPeopleKind, boolean> {
  const staff = args.canManage && ADDABLE_STATUSES.has(args.status);
  return {
    staff,
    guest: staff && !!args.role && hasMinRole(args.role, 'team_leader'),
  };
}

/** The workspace's people of that kind not yet in the room's channel. */
export function addPeopleCandidates(
  people: readonly ChatPerson[],
  members: readonly Pick<ChannelMember, 'userId'>[],
  kind: AddPeopleKind
): ChatPerson[] {
  return addCandidates(people, members, {
    staff: kind === 'staff',
    guests: kind === 'guest',
    block: null,
  });
}
