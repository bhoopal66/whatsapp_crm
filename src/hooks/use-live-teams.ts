'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  cachedQuery,
  liveTeamsCacheKey,
  REFERENCE_CACHE_TTL_MS,
} from '@/lib/client-cache';
import { selectableTeams, type LiveTeam } from '@/lib/live-view/team-filter';
import { createClient } from '@/lib/supabase/client';

interface TeamRow {
  id: string;
  name: string;
  leader_user_id: string | null;
  team_members: { user_id: string }[] | null;
}

/**
 * The teams the Live view's filter offers: every team of the workspace
 * for an owner or admin, the teams they lead for a team leader. Teams
 * and their members are readable by any member (044), so this widens
 * nothing; the filter only narrows what `live_team_view()` returned.
 * A failed read offers no filter (an empty list), never an error.
 */
export function useLiveTeams(): LiveTeam[] {
  const { accountId, accountRole, user } = useAuth();
  const userId = user?.id ?? null;
  const [loaded, setLoaded] = useState<{
    key: string;
    teams: LiveTeam[];
  } | null>(null);
  const admin = !!accountRole && hasMinRole(accountRole, 'admin');
  const leader = !!accountRole && hasMinRole(accountRole, 'team_leader');
  const key =
    accountId && userId && leader
      ? liveTeamsCacheKey(accountId, userId, admin ? 'all' : 'led')
      : null;

  useEffect(() => {
    if (!key || !accountId || !userId) return;
    let live = true;
    (async () => {
      const teams = await cachedQuery(key, REFERENCE_CACHE_TTL_MS, async () => {
        let query = createClient()
          .from('teams')
          .select('id, name, leader_user_id, team_members(user_id)')
          .eq('account_id', accountId);
        if (!admin) query = query.eq('leader_user_id', userId);
        const { data, error } = await query;
        if (error || !data) throw new Error('teams read failed');
        return (data as TeamRow[]).map((t): LiveTeam => ({
          id: t.id,
          name: t.name,
          leaderUserId: t.leader_user_id,
          memberIds: (t.team_members ?? []).map((m) => m.user_id),
        }));
      }).catch(() => [] as LiveTeam[]);
      if (live) setLoaded({ key, teams });
    })();
    return () => {
      live = false;
    };
  }, [key, accountId, userId, admin]);

  if (!key || !loaded || loaded.key !== key) return [];
  return selectableTeams(loaded.teams, userId, accountRole);
}
