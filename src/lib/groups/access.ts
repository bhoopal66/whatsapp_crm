/**
 * Who may see, manage and create a WhatsApp group. Mirror of 114, 208 and
 * 218 (whatsapp_group_visible_ids / _manageable_ids / _can_create) —
 * change both. It informs UI and route decisions only; the database decides.
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
 * manage, while the group still has a number. Whoever that number is
 * allocated to (218): appointing a manager is the grant for the group;
 * allocation decides only 1:1 chats and creating groups (canCreateGroup).
 */
export function canManageGroup(args: {
  role: AccountRole;
  userId: string;
  group: GroupManageFacts;
}): boolean {
  const { role, userId, group } = args;
  if (canViewAllGroups(role)) return true;
  if (role !== 'agent' && role !== 'team_leader') return false;
  return group.channelId !== null && worksGroup(userId, group);
}

/**
 * May this number host a group? A Whapi number, or a company (not
 * personal, 190) OpenWA number; never Meta. Mirror of 208's
 * whatsapp_group_can_create / whatsapp_groups_guard — change both.
 */
export function isGroupCapableNumber(number: {
  provider: string;
  is_personal?: boolean | null;
}): boolean {
  if (number.provider === 'whapi') return true;
  return number.provider === 'openwa' && !number.is_personal;
}

/**
 * Agent and up, on a number they may use. The number's kind is checked
 * by isGroupCapableNumber, which narrows usableChannelIds first.
 */
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
 * Why adding people to a group is unavailable, or null. Wider than
 * managing (2026-11-20): any staff member at agent level or above who
 * can open the group may add people; removing, promoting, settings and
 * the rest stay with its managers. WhatsApp's own rule still holds:
 * our number must be a group admin to add anyone.
 */
export function groupAddBlock(args: {
  role: AccountRole;
  group: {
    channelId: string | null;
    ourRole: 'admin' | 'member' | 'left';
  };
}): GroupActionBlock | null {
  const { role, group } = args;
  if (!hasMinRole(role, 'agent')) return 'not_allowed';
  if (group.channelId === null) return 'number_removed';
  if (group.ourRole === 'left') return 'left';
  if (group.ourRole !== 'admin') return 'not_group_admin';
  return null;
}

/**
 * Why an action on a group is unavailable, or null. `adminOnly` marks
 * the Whapi actions only a group admin may do (edit info/settings/icon,
 * add/remove/promote/demote, invite link, join requests).
 */
export function groupActionBlock(args: {
  role: AccountRole;
  userId: string;
  group: GroupManageFacts & { ourRole: 'admin' | 'member' | 'left' };
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
