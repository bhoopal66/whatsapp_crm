/**
 * Who may see, manage and create a WhatsApp group. Mirror of 114
 * (whatsapp_group_visible_ids / _manageable_ids / _can_create) — change
 * both. It informs UI and route decisions only; the database decides.
 */
import {
  canCreateGroups,
  canSyncGroups as roleCanSyncGroups,
  canViewAllGroups,
  hasMinRole,
  type AccountRole,
} from '@/lib/auth/roles';

export interface GroupAccessFacts {
  createdBy: string | null;
  managerIds: readonly string[];
}

export interface GroupManageFacts extends GroupAccessFacts {
  channelId: string | null;
}

function worksGroup(userId: string, g: GroupAccessFacts): boolean {
  return g.createdBy === userId || g.managerIds.includes(userId);
}

/**
 * Admin and up: all. Viewer through team leader: groups they created or
 * manage; a team leader also those of the people they lead
 * (`ledTeamMemberIds`: members of the teams they lead). Never a guest.
 */
export function canViewGroup(args: {
  role: AccountRole;
  userId: string;
  group: GroupAccessFacts;
  ledTeamMemberIds?: readonly string[];
}): boolean {
  const { role, userId, group, ledTeamMemberIds = [] } = args;
  if (canViewAllGroups(role)) return true;
  if (!hasMinRole(role, 'viewer')) return false;
  if (worksGroup(userId, group)) return true;
  if (role !== 'team_leader') return false;
  const led = new Set(ledTeamMemberIds);
  return (
    (group.createdBy !== null && led.has(group.createdBy)) ||
    group.managerIds.some((m) => led.has(m))
  );
}

/**
 * Admin and up: all. Agent or team leader: groups they created or
 * manage, on a number that still exists and they may use.
 */
export function canManageGroup(args: {
  role: AccountRole;
  userId: string;
  group: GroupManageFacts;
  usableChannelIds: readonly string[];
}): boolean {
  const { role, userId, group, usableChannelIds } = args;
  if (canViewAllGroups(role)) return true;
  if (role !== 'agent' && role !== 'team_leader') return false;
  return (
    group.channelId !== null &&
    worksGroup(userId, group) &&
    usableChannelIds.includes(group.channelId)
  );
}

/** Agent and up, on a number they may use. */
export function canCreateGroup(
  role: AccountRole,
  channelId: string | null,
  usableChannelIds: readonly string[]
): boolean {
  return (
    canCreateGroups(role) &&
    channelId !== null &&
    usableChannelIds.includes(channelId)
  );
}

export function canSyncGroups(role: AccountRole): boolean {
  return roleCanSyncGroups(role);
}

export type GroupActionBlock =
  'not_allowed' | 'number_removed' | 'not_group_admin' | 'left';

/**
 * Why an action on a group is unavailable, or null. `adminOnly` marks
 * the Whapi actions only a group admin may do (edit info/settings/icon,
 * add/remove/promote/demote, invite link, join requests).
 */
export function groupActionBlock(args: {
  role: AccountRole;
  userId: string;
  group: GroupManageFacts & { ourRole: 'admin' | 'member' | 'left' };
  usableChannelIds: readonly string[];
  adminOnly?: boolean;
}): GroupActionBlock | null {
  const { role, group, adminOnly = false } = args;
  if (!canViewAllGroups(role) && role !== 'agent' && role !== 'team_leader') {
    return 'not_allowed';
  }
  if (group.channelId === null) {
    return canViewAllGroups(role) || worksGroup(args.userId, group)
      ? 'number_removed'
      : 'not_allowed';
  }
  if (!canManageGroup(args)) return 'not_allowed';
  if (group.ourRole === 'left') return 'left';
  if (adminOnly && group.ourRole !== 'admin') return 'not_group_admin';
  return null;
}
