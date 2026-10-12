/**
 * Deal rooms — how the Members panel draws a person (module 014c), pure
 * so it is tested without a DOM. Imports from `./reads` are type-only.
 */

import type { RosterEntry, StaffParticipant } from './reads';

export type MemberRole =
  'customer' | 'partner' | 'bank' | 'business' | 'person';

export type MemberBadge =
  | 'consent'
  | 'guest'
  | 'pending'
  | 'invited'
  | 'joined'
  | 'left'
  | 'removed'
  | 'rejected';

export interface MemberRow {
  role: MemberRole;
  /** A bank guest's bank code. */
  bank: string | null;
  /** Masked, as the detail sends it; null for a guest viewer. */
  phone: string | null;
  /** The role's badge first (consent, guest), then the status. */
  badges: MemberBadge[];
  /** A manager may remove someone in the group (never our number). */
  removable: boolean;
}

const STATUS_BADGE: Record<string, MemberBadge> = {
  pending_approval: 'pending',
  invited: 'invited',
  joined: 'joined',
  left: 'left',
  removed: 'removed',
  rejected: 'rejected',
};

const isStaffView = (p: RosterEntry): p is StaffParticipant => 'consent' in p;

export function memberRow(
  p: StaffParticipant | RosterEntry,
  canManage: boolean
): MemberRow {
  const role: MemberRole =
    p.role === 'customer' || p.role === 'partner' || p.role === 'business'
      ? p.role
      : p.role === 'bank_guest'
        ? 'bank'
        : 'person';
  const staff = isStaffView(p) ? p : null;
  const badges: MemberBadge[] = [];
  if (role === 'customer' && staff?.consent) badges.push('consent');
  if (role === 'bank') badges.push('guest');
  const status = STATUS_BADGE[p.status];
  if (status) badges.push(status);
  return {
    role,
    bank: staff?.bankCode ?? null,
    phone: staff?.phone ?? null,
    badges,
    removable: canManage && role !== 'business' && p.status === 'joined',
  };
}

/** The people listed under the business number: ours is drawn apart. */
export const listedPeople = <T extends RosterEntry>(people: readonly T[]) =>
  people.filter((p) => p.role !== 'business');
