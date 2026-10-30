/**
 * The channel header's two rule dialogs: posting permissions (157) and a
 * team channel's audience (159). Pure, so the forms and the header badges
 * share one reading of the stored values; the database decides.
 */

import type { Channel, ChannelRule } from './types';
import { canManageChannel, type ManageCtx } from './view';

// ---------- who may change them ----------

export interface ChannelRuleActions {
  /** Posting permissions: team and private channels. */
  policy: boolean;
  /** Who can see the channel: team channels only. */
  audience: boolean;
}

/**
 * The same gate as rename / topic (chat_assert_can_manage_channel, 091):
 * a channel admin, or a workspace owner / admin who in a private channel
 * is a member; never on an archived channel.
 */
export function channelRuleActions(c: ManageCtx): ChannelRuleActions {
  const may = canManageChannel(c) && !c.archived;
  return { policy: may, audience: may && c.kind === 'team' };
}

// ---------- posting permissions (157) ----------

export const POLICY_FIELDS = [
  'posting',
  'threadReplies',
  'mentionEveryone',
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];
export type ChannelPolicy = Record<PolicyField, ChannelRule>;

export const policyOf = (c: Pick<Channel, PolicyField>): ChannelPolicy => ({
  posting: c.posting,
  threadReplies: c.threadReplies,
  mentionEveryone: c.mentionEveryone,
});

/**
 * The setChannelPolicy argument: only the fields the form changed
 * (omitted = keep), or null when nothing changed.
 */
export function policyChanges(
  stored: ChannelPolicy,
  form: ChannelPolicy
): Partial<ChannelPolicy> | null {
  const out: Partial<ChannelPolicy> = {};
  for (const f of POLICY_FIELDS) if (form[f] !== stored[f]) out[f] = form[f];
  return Object.keys(out).length > 0 ? out : null;
}

/** The header's "Announcements" badge: only admins may post top-level. */
export const isAnnouncementChannel = (c: Pick<Channel, 'posting'>): boolean =>
  c.posting === 'admins';

// ---------- audience (159) ----------

/**
 * The form's minimum-role choices. 'viewer' is the lowest staff role, so
 * a stored 'viewer' reads as All staff (null) and saves back as null.
 */
export const AUDIENCE_ROLE_OPTIONS = [
  'all',
  'agent',
  'team_leader',
  'admin',
] as const;
export type AudienceRoleOption = (typeof AUDIENCE_ROLE_OPTIONS)[number];

export function audienceRoleOption(
  minRole: string | null | undefined
): AudienceRoleOption {
  return minRole === 'agent' || minRole === 'team_leader' || minRole === 'admin'
    ? minRole
    : 'all';
}

export const audienceMinRole = (o: AudienceRoleOption): string | null =>
  o === 'all' ? null : o;

export interface AudienceForm {
  role: AudienceRoleOption;
  teamIds: readonly string[];
  /**
   * The stored audience_team_restricted (159): teams were chosen. Absent
   * in what a form will save, since the server sets it from the team list.
   */
  teamRestricted?: boolean;
}

/**
 * Teams were chosen and every one has since been deleted, which leaves
 * the channel to owners and admins only (159's audience_team_restricted
 * with no teams left).
 */
export const audienceTeamsDeleted = (form: AudienceForm): boolean =>
  !!form.teamRestricted && form.teamIds.length === 0;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/**
 * Whether Save would change anything (team order does not matter). A
 * channel whose teams were all deleted changes by saving with no teams,
 * which clears the flag.
 */
export const audienceChanged = (
  stored: AudienceForm,
  form: AudienceForm
): boolean =>
  stored.role !== form.role ||
  !sameSet(stored.teamIds, form.teamIds) ||
  audienceTeamsDeleted(stored) !== audienceTeamsDeleted(form);

/**
 * What the audience summary says, as parts for Chat.audience.summary:
 * `everyone` (unrestricted), `adminsOnly` (a minimum of admin leaves only
 * owners and admins, whatever the teams), `teamsDeleted` (the teams
 * chosen were all deleted: owners and admins only), else `restricted` with the role
 * floor and the chosen teams' names in the order given. Ids with no known
 * name are left out of the names.
 */
export type AudienceSummary =
  | { kind: 'everyone' }
  | { kind: 'adminsOnly' }
  | { kind: 'teamsDeleted' }
  | {
      kind: 'restricted';
      role: Exclude<AudienceRoleOption, 'admin'>;
      teams: string[];
    };

export function audienceSummary(
  form: AudienceForm,
  teams: readonly { id: string; name: string }[]
): AudienceSummary {
  if (form.role === 'admin') return { kind: 'adminsOnly' };
  if (audienceTeamsDeleted(form)) return { kind: 'teamsDeleted' };
  if (form.role === 'all' && form.teamIds.length === 0) {
    return { kind: 'everyone' };
  }
  const chosen = new Set(form.teamIds);
  const names = teams.filter((t) => chosen.has(t.id)).map((t) => t.name);
  return { kind: 'restricted', role: form.role, teams: names };
}

/**
 * The header's lock badge: a role floor above all staff, any team, or
 * teams chosen and since deleted.
 */
export const isRestrictedAudience = (form: AudienceForm): boolean =>
  form.role !== 'all' || form.teamIds.length > 0 || audienceTeamsDeleted(form);

/** Teams matching the picker's search, case-insensitively, by name. */
export function filterTeams<T extends { name: string }>(
  teams: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  return q ? teams.filter((t) => t.name.toLowerCase().includes(q)) : [...teams];
}
