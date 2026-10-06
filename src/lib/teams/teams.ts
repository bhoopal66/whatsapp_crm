// ============================================================
// Settings → Teams, the pure part.
//
// Everything the Teams screen decides without I/O: the summary counts,
// who is already spoken for by another team, the member picker's
// filter, and — the one that matters most — the PATCH body for an
// edited team. The editor saves as one form, and the route replaces
// `member_ids` / `channel_ids` wholesale, so sending a field that did
// not change is not harmless: it re-writes the team's membership and
// number allocation, and each re-write regrants or revokes access.
// `buildTeamPatch` sends only what the admin actually changed.
//
// The database is the authority on every rule mirrored here (one team
// per person is a unique index; access to an allocated number is
// granted in SQL). This module only decides what to show and write.
// ============================================================

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/** A team as `GET /api/account/teams` returns it. */
export interface Team {
  id: string;
  name: string;
  leader_user_id: string | null;
  created_at: string;
  member_ids: string[];
  /** WhatsApp numbers (`whatsapp_config.id`) allocated to the team. */
  channel_ids: string[];
}

/** The editable part of a team: what the editor holds as its draft. */
export type TeamDraft = Pick<
  Team,
  'name' | 'leader_user_id' | 'member_ids' | 'channel_ids'
>;

/** Body for `PATCH /api/account/teams/[id]`; only changed fields. */
export type TeamPatch = Partial<TeamDraft>;

/** The fields of a member these helpers read. */
export interface TeamPerson {
  user_id: string;
  full_name: string;
  email: string | null;
  role: AccountRole;
  deactivated_at: string | null;
}

/** Mirrors `MAX_NAME_LEN` in the teams API routes. */
export const TEAM_NAME_MAX = 60;

export function draftOf(team: Team): TeamDraft {
  return {
    name: team.name,
    leader_user_id: team.leader_user_id,
    member_ids: [...team.member_ids],
    channel_ids: [...team.channel_ids],
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * The PATCH body that turns `original` into `draft`, holding only the
 * fields that changed. Lists compare as sets (ticking a box off and on
 * again is no change) and are sent de-duplicated. The name is compared
 * and sent trimmed, as the route stores it. An empty object means
 * nothing to save.
 */
export function buildTeamPatch(original: Team, draft: TeamDraft): TeamPatch {
  const patch: TeamPatch = {};
  const name = draft.name.trim();
  if (name !== original.name) patch.name = name;
  if (draft.leader_user_id !== original.leader_user_id) {
    patch.leader_user_id = draft.leader_user_id;
  }
  if (!sameSet(draft.member_ids, original.member_ids)) {
    patch.member_ids = [...new Set(draft.member_ids)];
  }
  if (!sameSet(draft.channel_ids, original.channel_ids)) {
    patch.channel_ids = [...new Set(draft.channel_ids)];
  }
  return patch;
}

export function isEmptyPatch(patch: TeamPatch): boolean {
  return Object.keys(patch).length === 0;
}

export type TeamNameProblem = 'required' | 'tooLong' | null;

export function teamNameProblem(name: string): TeamNameProblem {
  const trimmed = name.trim();
  if (!trimmed) return 'required';
  if (trimmed.length > TEAM_NAME_MAX) return 'tooLong';
  return null;
}

/**
 * True when the draft allocates numbers to a team nobody is in — no
 * members and no leader. The database treats a number allocated only
 * to an empty team as still shared with everyone, so the admin is
 * warned rather than led to think the number is now restricted.
 */
export function allocationStaysShared(draft: TeamDraft): boolean {
  return (
    draft.channel_ids.length > 0 &&
    draft.member_ids.length === 0 &&
    !draft.leader_user_id
  );
}

/**
 * user id → the team that holds them as a member, leaving out
 * `exceptTeamId`. A person is in at most one team (unique index), so
 * anyone in this map is unavailable to the team being edited.
 */
export function membershipElsewhere(
  teams: readonly Team[],
  exceptTeamId: string | null
): Map<string, Team> {
  const held = new Map<string, Team>();
  for (const team of teams) {
    if (team.id === exceptTeamId) continue;
    for (const userId of team.member_ids) held.set(userId, team);
  }
  return held;
}

/**
 * Owners and admins see every chat and every number whatever team they
 * are in, so leaving them out of a team is not a gap worth reporting.
 */
function seesEverything(person: TeamPerson): boolean {
  return hasMinRole(person.role, 'admin');
}

/** Active people who are neither a member nor a leader of any team. */
export function unassignedMembers<P extends TeamPerson>(
  teams: readonly Team[],
  members: readonly P[]
): P[] {
  const placed = new Set<string>();
  for (const team of teams) {
    for (const id of team.member_ids) placed.add(id);
    if (team.leader_user_id) placed.add(team.leader_user_id);
  }
  return members.filter(
    (m) => !m.deactivated_at && !seesEverything(m) && !placed.has(m.user_id)
  );
}

export interface TeamsSummary {
  teams: number;
  /** Distinct people who are a member or a leader of some team. */
  inTeams: number;
  /** See `unassignedMembers`. */
  unassigned: number;
}

export function summarizeTeams(
  teams: readonly Team[],
  members: readonly TeamPerson[]
): TeamsSummary {
  const known = new Set(members.map((m) => m.user_id));
  const placed = new Set<string>();
  for (const team of teams) {
    for (const id of team.member_ids) if (known.has(id)) placed.add(id);
    if (team.leader_user_id && known.has(team.leader_user_id)) {
      placed.add(team.leader_user_id);
    }
  }
  return {
    teams: teams.length,
    inTeams: placed.size,
    unassigned: unassignedMembers(teams, members).length,
  };
}

/**
 * The people a team's pickers offer: active members, plus anyone
 * already in `keepIds` even if deactivated (so a deactivated member
 * can still be removed from the team). Sorted by display name.
 */
export function pickableMembers<P extends TeamPerson>(
  members: readonly P[],
  keepIds: readonly string[]
): P[] {
  const keep = new Set(keepIds);
  return members
    .filter((m) => !m.deactivated_at || keep.has(m.user_id))
    .sort((a, b) =>
      displayName(a).localeCompare(displayName(b), undefined, {
        sensitivity: 'base',
      })
    );
}

/** Case-insensitive match on name or email; a blank query keeps all. */
export function searchMembers<P extends TeamPerson>(
  members: readonly P[],
  query: string
): P[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...members];
  return members.filter(
    (m) =>
      m.full_name.toLocaleLowerCase().includes(q) ||
      (m.email ?? '').toLocaleLowerCase().includes(q)
  );
}

export function displayName(m: Pick<TeamPerson, 'full_name' | 'email'>) {
  return m.full_name.trim() || m.email || '';
}

/** Up to two initials for an avatar fallback ("Sara Ali" → "SA"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? (Array.from(words.at(-1)!)[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}
