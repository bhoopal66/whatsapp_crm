// ============================================================
// Settings → Numbers & access: who a number reaches once teams are
// allocated to it as well as people (migration 071).
//
// A number's access list in the database is one row per person, with
// `direct` (ticked by hand) and `via_team` (kept in step with team
// membership by triggers). The access dialog edits the two inputs —
// the direct ticks and the team ticks — and has to show the result
// before it is saved, so ticking a team shows its people at once. This
// is that result, computed the same way the triggers do: a team grants
// its members AND its leader.
//
// Pure, so it is tested without a DOM. The database decides; this only
// decides what the dialog shows.
// ============================================================

export interface TeamRoster {
  id: string;
  name: string;
  leader_user_id: string | null;
  member_ids: string[];
}

/** Everyone a team allocation grants: its members plus its leader. */
export function teamPeople(team: TeamRoster): string[] {
  const people = new Set(team.member_ids);
  if (team.leader_user_id) people.add(team.leader_user_id);
  return [...people];
}

export interface EffectiveAccess {
  /** Everyone who would have the number: direct ticks plus team people. */
  people: string[];
  /**
   * Person → the selected teams that give them the number, in the
   * order the teams are listed. Only people reached through a team.
   */
  viaTeams: Map<string, string[]>;
  /** Nobody at all: the number stays shared with everyone. */
  shared: boolean;
  /**
   * Teams are selected but none of them has anybody in it, so the
   * selection grants nothing yet and the number stays shared. Worth a
   * warning: the admin meant to restrict it.
   */
  teamsEmpty: boolean;
}

/**
 * The access a number would have with these direct ticks and these
 * team ticks.
 *
 * `currentMemberIds` limits the result to people still on the account
 * — a team roster or an old direct tick can name someone who has left,
 * and counting a ghost would call a number "allocated" that the
 * database (which checks membership first) treats as shared.
 */
export function effectiveAccess(
  directIds: readonly string[],
  teamIds: readonly string[],
  teams: readonly TeamRoster[],
  currentMemberIds: ReadonlySet<string>
): EffectiveAccess {
  const selected = new Set(teamIds);
  const viaTeams = new Map<string, string[]>();
  for (const team of teams) {
    if (!selected.has(team.id)) continue;
    for (const userId of teamPeople(team)) {
      if (!currentMemberIds.has(userId)) continue;
      const names = viaTeams.get(userId) ?? [];
      names.push(team.name);
      viaTeams.set(userId, names);
    }
  }

  const people = new Set(
    directIds.filter((userId) => currentMemberIds.has(userId))
  );
  for (const userId of viaTeams.keys()) people.add(userId);

  return {
    people: [...people],
    viaTeams,
    shared: people.size === 0,
    teamsEmpty: selected.size > 0 && viaTeams.size === 0,
  };
}

/**
 * A saved number's access, as the channel list reports it: the direct
 * list plus the team-derived one, without repeats. A team allocation
 * alone makes a number allocated; teams with nobody in them leave it
 * shared, which is worth saying.
 */
export function savedAccess(row: {
  member_ids: readonly string[];
  team_ids: readonly string[];
  team_member_ids: readonly string[];
}): Omit<EffectiveAccess, 'viaTeams'> {
  const people = [...new Set([...row.member_ids, ...row.team_member_ids])];
  return {
    people,
    shared: people.length === 0,
    teamsEmpty: row.team_ids.length > 0 && row.team_member_ids.length === 0,
  };
}
