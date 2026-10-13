/**
 * Who may add people, change roles and leave in the members panel: the
 * rules of chat_add_members, chat_set_member_role and chat_leave_channel
 * (087), mirrored for the UI only. The database decides; these only
 * decide what the panel offers and why it is disabled.
 */
import type {
  ChannelKind,
  ChannelMember,
  ChannelRole,
  ChatPerson,
} from './types';
import { canManageChannel } from './view';

/** The workspace roles chat_user_role maps to owner/admin/supervisor. */
const GUEST_ADDERS: ReadonlySet<string> = new Set([
  'owner',
  'admin',
  'team_leader',
]);
const WORKSPACE_ADMINS: ReadonlySet<string> = new Set(['owner', 'admin']);

export const isGuestPerson = (
  p: Pick<ChatPerson, 'role'> | null | undefined
): boolean => p?.role === 'bank_guest';

export interface ChannelCtx {
  kind: ChannelKind;
  archived: boolean;
  /** The viewer's role in the channel; null when not a member. */
  myRole: ChannelRole | null;
  /** The viewer's workspace (account) role. */
  accountRole: string | null;
}

export type AddBlock =
  'guest' | 'dm' | 'dealRoom' | 'archived' | 'notMember' | 'notAdmin';

export interface AddRules {
  /** May add non-guests. */
  staff: boolean;
  /** May add bank guests. */
  guests: boolean;
  /** Why nobody can be added; null when someone can. */
  block: AddBlock | null;
}

const nobody = (block: AddBlock): AddRules => ({
  staff: false,
  guests: false,
  block,
});

/**
 * Team: any non-guest adds non-guests, never a guest. Private: only a
 * member; channel admins add non-guests, and a member who is a workspace
 * owner/admin/team leader adds bank guests (whatever their channel role).
 */
export function addRules(c: ChannelCtx): AddRules {
  if (!c.accountRole || c.accountRole === 'bank_guest') return nobody('guest');
  if (c.kind === 'dm') return nobody('dm');
  if (c.kind === 'deal_room') return nobody('dealRoom');
  if (c.archived) return nobody('archived');
  if (c.kind === 'team') return { staff: true, guests: false, block: null };
  if (!c.myRole) return nobody('notMember');
  const staff = c.myRole === 'admin';
  const guests = GUEST_ADDERS.has(c.accountRole);
  return staff || guests ? { staff, guests, block: null } : nobody('notAdmin');
}

/** The people the viewer may add: not yet members, and of a kind the rules allow. */
export function addCandidates(
  people: readonly ChatPerson[],
  members: readonly Pick<ChannelMember, 'userId'>[],
  rules: AddRules
): ChatPerson[] {
  const inside = new Set(members.map((m) => m.userId.toLowerCase()));
  return people.filter(
    (p) =>
      !inside.has(p.userId.toLowerCase()) &&
      (isGuestPerson(p) ? rules.guests : rules.staff)
  );
}

/** Private: channel admins only. Team: channel admins or workspace owner/admin. */
export function canSetRoles(c: ChannelCtx): boolean {
  if (!c.accountRole || c.accountRole === 'bank_guest') return false;
  if ((c.kind !== 'team' && c.kind !== 'private') || c.archived) return false;
  if (c.myRole === 'admin') return true;
  return c.kind === 'team' && WORKSPACE_ADMINS.has(c.accountRole);
}

interface Roster {
  members: readonly ChannelMember[];
  peopleById: ReadonlyMap<string, ChatPerson>;
}

/** Admins other than `userId` who still count: in the workspace and not a guest (as in SQL). */
function otherAdmins(r: Roster, userId: string): number {
  const me = userId.toLowerCase();
  return r.members.filter((m) => {
    if (m.role !== 'admin' || m.userId.toLowerCase() === me) return false;
    const p = r.peopleById.get(m.userId.toLowerCase());
    return !!p && !isGuestPerson(p);
  }).length;
}

export interface RoleChange {
  to: 'admin' | 'member';
  /** Set when the change exists but the database would refuse it. */
  block: 'lastAdmin' | null;
}

/** The one role change the menu offers for `target`; null = no menu. Guests never change. */
export function roleChange(
  target: ChannelMember,
  c: ChannelCtx & Roster
): RoleChange | null {
  if (!canSetRoles(c) || target.role === 'guest') return null;
  if (target.role === 'member') return { to: 'admin', block: null };
  const last = c.kind === 'private' && otherAdmins(c, target.userId) === 0;
  return { to: 'member', block: last ? 'lastAdmin' : null };
}

/**
 * Whether the panel offers removing `target` (chat_remove_member, 091):
 * someone else (the viewer leaves instead), from a live channel the
 * viewer may manage (canManageChannel), and never the last admin who
 * still counts (in the workspace, not a guest, as in SQL) — on a team
 * channel too, unlike a role change. Hidden rather than offered
 * disabled; the database decides.
 */
export function canRemoveMember(
  target: Pick<ChannelMember, 'userId' | 'role'>,
  c: ChannelCtx & Roster & { userId: string }
): boolean {
  if (c.archived || !canManageChannel(c)) return false;
  if (target.userId.toLowerCase() === c.userId.toLowerCase()) return false;
  return target.role !== 'admin' || otherAdmins(c, target.userId) > 0;
}

export type LeaveBlock = 'notMember' | 'lastMember' | 'lastAdmin';

/**
 * Why the viewer cannot leave; null when they can. Archiving blocks
 * nothing here: chat_leave_channel (087) has no archived check, unlike
 * adds and role changes, so leaving is the one membership change an
 * archived channel takes (a private one cannot then be rejoined until
 * it is unarchived).
 */
export function leaveBlock(
  c: Pick<ChannelCtx, 'kind' | 'myRole'> & Roster & { userId: string }
): LeaveBlock | null {
  if (!c.myRole) return 'notMember';
  const me = c.userId.toLowerCase();
  if (c.kind === 'dm' && !c.members.some((m) => m.userId.toLowerCase() !== me))
    return 'lastMember';
  if (
    (c.kind === 'private' || c.kind === 'deal_room') &&
    c.myRole === 'admin' &&
    otherAdmins(c, c.userId) === 0
  )
    return 'lastAdmin';
  return null;
}

const ROLE_ORDER: Record<ChannelRole, number> = {
  admin: 0,
  member: 1,
  guest: 2,
};

/** Admins, then members, then guests; by name within each. */
export function sortMembers(
  members: readonly ChannelMember[],
  peopleById: ReadonlyMap<string, ChatPerson>
): ChannelMember[] {
  const name = (m: ChannelMember) =>
    peopleById.get(m.userId.toLowerCase())?.fullName ?? '￿';
  return [...members].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      name(a).localeCompare(name(b)) ||
      a.userId.localeCompare(b.userId)
  );
}
