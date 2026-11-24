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
  /** Nobody chosen at all: the number is shared with everyone. */
  shared: boolean;
  /** Limited, but nobody is left on it: owners and admins only (314). */
  adminsOnly: boolean;
  /** Teams are selected but none of them has anybody in it. */
  teamsEmpty: boolean;
}

/**
 * The access a number would have with these direct ticks and these
 * team ticks.
 *
 * `currentMemberIds` limits the result to people still on the account
 * — a team roster or an old direct tick can name someone who has left.
 * Any tick limits the number (314), even one that reaches nobody yet.
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
    shared: directIds.length === 0 && selected.size === 0,
    adminsOnly:
      people.size === 0 && (directIds.length > 0 || selected.size > 0),
    teamsEmpty: selected.size > 0 && viaTeams.size === 0,
  };
}

/**
 * A saved number's access, as the channel list reports it: the direct
 * list plus the team-derived one, without repeats. `isLive` leaves out
 * people who can no longer sign in. With nobody left, a limited number is
 * for owners and admins (314).
 */
export function savedAccess(
  row: {
    member_ids: readonly string[];
    team_ids: readonly string[];
    team_member_ids: readonly string[];
    access_restricted?: boolean;
  },
  isLive: (userId: string) => boolean = () => true
): Omit<EffectiveAccess, 'viaTeams'> {
  const all = [...new Set([...row.member_ids, ...row.team_member_ids])];
  const people = all.filter(isLive);
  const restricted =
    row.access_restricted === true || all.length > 0 || row.team_ids.length > 0;
  return {
    people,
    shared: !restricted,
    adminsOnly: restricted && people.length === 0,
    teamsEmpty: row.team_ids.length > 0 && !row.team_member_ids.some(isLive),
  };
}

/** A number as `GET /api/whatsapp/channels` lists it. */
export interface AccessRow {
  id: string;
  is_personal?: boolean;
  member_ids: readonly string[];
  team_ids: readonly string[];
  team_member_ids: readonly string[];
}

/**
 * The numbers nobody but owners and admins may use once `leaving` is gone:
 * a person removed or deactivated, a team deleted, or a team saved with
 * other people (`team`, as it would be saved). Numbers already without a live person, shared and personal numbers are not named.
 */
export function numbersLeftToAdmins<N extends AccessRow>(
  numbers: readonly N[],
  teams: readonly TeamRoster[],
  leaving: { userId: string } | { teamId: string } | { team: TeamRoster },
  isLive: (userId: string) => boolean = () => true
): N[] {
  return numbers.filter((n) => {
    if (n.is_personal) return false;
    const before = new Set(
      [...n.member_ids, ...n.team_member_ids].filter(isLive)
    );
    if (before.size === 0) return false;
    if ('userId' in leaving) {
      before.delete(leaving.userId);
      return before.size === 0;
    }
    const teamId = 'team' in leaving ? leaving.team.id : leaving.teamId;
    if (!n.team_ids.includes(teamId)) return false;
    const kept = teams.filter(
      (t) => t.id !== teamId && n.team_ids.includes(t.id)
    );
    if ('team' in leaving) kept.push(leaving.team);
    return ![...n.member_ids, ...kept.flatMap(teamPeople)].some(isLive);
  });
}
