// ============================================================
// Who a deal belongs to, and whose deals a member may look at or
// hand a deal to (migration 080). Pure, so the pipelines screen and
// the deal form share one answer and it can be unit-tested.
//
// A deal belongs to one person: its assignee, else whoever created
// it. The two columns name that person differently —
// `deals.assigned_to` is a `profiles.id`, `deals.user_id` an auth
// user id (`profiles.user_id`) — so a person is always carried as
// both ids. RLS decides which deals a member gets back
// (`can_view_deal`); this only shapes the pickers and narrows within
// what RLS already returned.
// ============================================================

import { canLeadTeam, hasMinRole, type AccountRole } from '@/lib/auth/roles';

/** The two ids a person is known by. */
export interface PersonIds {
  /** `profiles.id` — what `deals.assigned_to` stores. */
  id: string;
  /** Auth user id — what `deals.user_id` and `team_members` store. */
  user_id: string;
}

export interface DealOwnerFields {
  assigned_to?: string | null;
  user_id: string;
}

/** The deal's owner among `people`: the assignee, else the creator. */
export function dealOwnerProfile<P extends PersonIds>(
  deal: DealOwnerFields,
  people: readonly P[]
): P | null {
  if (deal.assigned_to) {
    return people.find((p) => p.id === deal.assigned_to) ?? null;
  }
  return people.find((p) => p.user_id === deal.user_id) ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgREST `or` filter for one person's deals: assigned to them, or
 * unassigned and created by them. Both ids are interpolated into the
 * query string, so anything that is not a UUID yields null rather
 * than a filter a stray `,` or `)` could rewrite.
 */
export function dealOwnerOrFilter(person: PersonIds): string | null {
  if (!UUID_RE.test(person.id) || !UUID_RE.test(person.user_id)) return null;
  return `assigned_to.eq.${person.id},and(assigned_to.is.null,user_id.eq.${person.user_id})`;
}

export type OwnerOption<P extends PersonIds> =
  | { key: 'everyone'; kind: 'everyone' }
  | { key: 'team'; kind: 'team' }
  | { key: 'mine'; kind: 'mine'; person: P }
  | { key: string; kind: 'person'; person: P };

export interface DealPeopleInput<P extends PersonIds> {
  role: AccountRole | null;
  /** The signed-in member's profile; null while loading. */
  me: P | null;
  /** The account's members (the cached profiles list). */
  members: readonly P[];
  /** Auth user ids of the members of every team `me` leads. */
  ledUserIds: ReadonlySet<string>;
}

/** Admin and up see, and may own deals for, everyone in the account. */
function seesEveryone(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/** The members a team leader leads, without themselves. */
function teammates<P extends PersonIds>(input: DealPeopleInput<P>): P[] {
  return input.members.filter(
    (p) => p.id !== input.me?.id && input.ledUserIds.has(p.user_id)
  );
}

/**
 * The "Showing" picker's options, the default first. Admins: Everyone,
 * My deals, each other member. A team leader: My team (all RLS
 * returns), My deals, each teammate. Anyone else: none — RLS already
 * narrows them to their own deals, so there is nothing to pick.
 */
export function ownerFilterOptions<P extends PersonIds>(
  input: DealPeopleInput<P>
): OwnerOption<P>[] {
  const { role, me, members } = input;
  if (!role || !me) return [];
  let first: OwnerOption<P>;
  let others: P[];
  if (seesEveryone(role)) {
    first = { key: 'everyone', kind: 'everyone' };
    others = members.filter((p) => p.id !== me.id);
  } else if (canLeadTeam(role)) {
    first = { key: 'team', kind: 'team' };
    others = teammates(input);
  } else {
    return [];
  }
  return [
    first,
    { key: 'mine', kind: 'mine', person: me },
    ...others.map((person): OwnerOption<P> => ({
      key: person.id,
      kind: 'person',
      person,
    })),
  ];
}

/**
 * The people `me` may give a deal to: an admin anyone, a team leader
 * themselves and their teammates, anyone else only themselves.
 */
export function assignableOwners<P extends PersonIds>(
  input: DealPeopleInput<P>
): P[] {
  const { role, me, members } = input;
  if (!role || !me) return [];
  if (seesEveryone(role)) return [...members];
  if (canLeadTeam(role)) return [me, ...teammates(input)];
  return [me];
}
