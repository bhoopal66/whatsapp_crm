'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { canLeadTeam } from '@/lib/auth/roles';
import {
  cachedQuery,
  invalidateCached,
  REFERENCE_CACHE_TTL_MS,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { ledTeamIds } from '@/lib/cases/team-view';
import { createClient } from '@/lib/supabase/client';

export interface LedTeam {
  /** Team leader and up: the "My team" option is offered. */
  canLead: boolean;
  /**
   * Auth user ids of the people in the teams the viewer leads (044's
   * `teams.leader_user_id` / `team_members`, the active workspace by
   * RLS), plus the viewer. null while loading, after a failed read, or
   * for someone who cannot lead.
   */
  ids: readonly string[] | null;
  /** The roster could not be read: say so and offer `retry`. */
  failed: boolean;
  retry: () => void;
}

/**
 * The "My team" filter's people, for My worklist and Cases. A filter
 * over rows RLS already returned, never a grant. Same query and cache
 * key as the pipelines' roster (`use-deal-people.ts`), so the two
 * screens share one round trip.
 */
export function useLedTeam(): LedTeam {
  const { accountRole, accountId, user } = useAuth();
  const canLead = !!accountRole && canLeadTeam(accountRole);
  const leaderId = canLead ? (user?.id ?? null) : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    ids: readonly string[] | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  }, []);
  const key = leaderId && accountId ? `${accountId}:${leaderId}` : null;

  useEffect(() => {
    if (!leaderId || !key) return;
    let live = true;
    (async () => {
      const found = await cachedQuery(
        teamRosterCacheKey(leaderId),
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const { data, error } = await createClient()
            .from('teams')
            .select('team_members(user_id)')
            .eq('leader_user_id', leaderId);
          if (error || !data) return null;
          const out = new Set<string>();
          for (const team of data as {
            team_members: { user_id: string }[] | null;
          }[]) {
            for (const m of team.team_members ?? []) out.add(m.user_id);
          }
          return out;
        }
      ).catch(() => null);
      // The other users of this key cache a failure as null; drop it, or
      // Retry would be answered with it for the rest of the TTL.
      if (found === null) invalidateCached(teamRosterCacheKey(leaderId));
      if (!live) return;
      setLoaded({ key, ids: ledTeamIds(leaderId, found) });
    })();
    return () => {
      live = false;
    };
  }, [leaderId, key, attempt]);

  const current = loaded && loaded.key === key ? loaded : null;
  return {
    canLead,
    ids: current?.ids ?? null,
    failed: current !== null && current.ids === null,
    retry,
  };
}
