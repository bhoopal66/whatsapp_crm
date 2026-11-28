/**
 * The Live view's team filter (/live). A UI narrowing of the people
 * `live_team_view()` already returned through RLS: it never asks for
 * anyone the view did not hand over. Pure.
 *
 * A team leader picks among the teams they lead (default: all of
 * theirs); an owner or admin among every team of the workspace
 * (default: all teams). A team's picture is its members plus its
 * leader. Teams are one-per-person in SQL (044), but nothing here
 * relies on it: each person is returned once, in the order given.
 */
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

export interface LiveTeam {
  id: string;
  name: string;
  leaderUserId: string | null;
  /** Auth user ids of the members. */
  memberIds: readonly string[];
}

/** 'all', or a team id. */
export type LiveTeamSelection = string;

export const ALL_TEAMS: LiveTeamSelection = 'all';

/** Owner and admin may pick any team; a leader only the teams they lead. */
export function selectableTeams(
  teams: readonly LiveTeam[],
  viewerUserId: string | null,
  role: AccountRole | null
): LiveTeam[] {
  if (!role || !hasMinRole(role, 'team_leader')) return [];
  const sorted = [...teams].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  if (hasMinRole(role, 'admin')) return sorted;
  return sorted.filter(
    (t) => viewerUserId !== null && t.leaderUserId === viewerUserId
  );
}

/** A selection that is not one of the offered teams means "all". */
export function normalizeSelection(
  selection: LiveTeamSelection,
  selectable: readonly LiveTeam[]
): LiveTeamSelection {
  return selectable.some((t) => t.id === selection) ? selection : ALL_TEAMS;
}

/**
 * The people to show, each once, in the order given.
 *
 * - Owner or admin, "all teams": everyone the view returned (including
 *   people in no team).
 * - Team leader, "all": the members and leaders of the teams they lead,
 *   and themselves.
 * - A team: its members and its leader.
 */
export function filterLivePeople<P extends { userId: string }>(
  people: readonly P[],
  selectable: readonly LiveTeam[],
  selection: LiveTeamSelection,
  viewer: { userId: string | null; role: AccountRole | null }
): P[] {
  const picked = normalizeSelection(selection, selectable);
  const isAdmin = !!viewer.role && hasMinRole(viewer.role, 'admin');
  if (picked === ALL_TEAMS && isAdmin) return dedupe(people, null);

  const keep = new Set<string>();
  for (const t of selectable) {
    if (picked !== ALL_TEAMS && t.id !== picked) continue;
    for (const id of t.memberIds) keep.add(id);
    if (t.leaderUserId) keep.add(t.leaderUserId);
  }
  if (picked === ALL_TEAMS && viewer.userId) keep.add(viewer.userId);
  return dedupe(people, keep);
}

function dedupe<P extends { userId: string }>(
  people: readonly P[],
  keep: ReadonlySet<string> | null
): P[] {
  const seen = new Set<string>();
  const out: P[] = [];
  for (const p of people) {
    if ((keep && !keep.has(p.userId)) || seen.has(p.userId)) continue;
    seen.add(p.userId);
    out.push(p);
  }
  return out;
}
