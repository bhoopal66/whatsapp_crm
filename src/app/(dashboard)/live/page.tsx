'use client';

/**
 * The Live view (Track B item 8, migration 238): who is online and how
 * their customers are doing. One RPC (`live_team_view`) re-read every
 * 30 seconds while the tab is visible, and at once when the viewer
 * comes back to it. Never cached across visits (people's figures move
 * by the minute). The layout is the team-leader-and-up guard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveView } from '@/components/live-view/live-view';
import { useAuth } from '@/hooks/use-auth';
import { cachedQuery, REFERENCE_CACHE_TTL_MS } from '@/lib/client-cache';
import {
  LIVE_ALL_TEAMS,
  LIVE_REFRESH_MS,
  liveTeamOptions,
  loadLiveTeamView,
  type LiveTeamView,
} from '@/lib/live-view/view';
import { createClient } from '@/lib/supabase/client';

interface Loaded {
  accountId: string;
  view: LiveTeamView | null;
  error: 'not_allowed' | 'failed' | null;
  at: number;
}

/** The workspace's teams with their people; the same for every member of
 *  the workspace (044's teams_select), so keyed by the account alone. */
function liveTeamsCacheKey(accountId: string): string {
  return `live-teams:${accountId}`;
}

export default function LivePage() {
  const { accountId, user } = useAuth();
  const viewerId = user?.id ?? null;
  const [teamRows, setTeamRows] = useState<{
    accountId: string;
    rows: unknown;
  } | null>(null);
  const [teamPick, setTeamPick] = useState<{
    accountId: string;
    teamId: string;
  } | null>(null);

  // The team filter's list. A read failure only hides the filter.
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void cachedQuery(
      liveTeamsCacheKey(accountId),
      REFERENCE_CACHE_TTL_MS,
      async () => {
        const { data, error } = await createClient()
          .from('teams')
          .select('id, name, leader_user_id, team_members(user_id)')
          .eq('account_id', accountId);
        if (error) throw error;
        return data ?? [];
      }
    )
      .catch(() => null)
      .then((rows) => {
        if (live) setTeamRows({ accountId, rows });
      });
    return () => {
      live = false;
    };
  }, [accountId]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  // State is set only when the read settles (never synchronously: the
  // effect below calls this). The Refresh button turns its own spinner on.
  const read = useCallback(() => {
    if (!accountId || inFlight.current) return;
    inFlight.current = true;
    void loadLiveTeamView(createClient()).then((res) => {
      inFlight.current = false;
      setRefreshing(false);
      setLoaded((prev) => {
        const keep = prev && prev.accountId === accountId ? prev.view : null;
        return res.ok
          ? { accountId, view: res.view, error: null, at: Date.now() }
          : // A failed refresh keeps the last figures on screen.
            {
              accountId,
              view: keep,
              error: res.reason,
              at: prev?.at ?? Date.now(),
            };
      });
    });
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    read();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, LIVE_REFRESH_MS);
    const onFocus = () => read();
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [accountId, read]);

  const current = loaded && loaded.accountId === accountId ? loaded : null;
  const teams =
    current?.view && teamRows && teamRows.accountId === accountId
      ? liveTeamOptions(teamRows.rows, viewerId, current.view.scope)
      : [];
  const teamId =
    teamPick && teamPick.accountId === accountId
      ? teamPick.teamId
      : LIVE_ALL_TEAMS;

  return (
    <LiveView
      view={current?.view ?? null}
      error={current?.error ?? null}
      now={current?.at ?? 0}
      updatedLabel={
        current?.view
          ? new Date(current.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          : null
      }
      refreshing={refreshing}
      teams={teams}
      teamId={teamId}
      onTeamId={(id) => accountId && setTeamPick({ accountId, teamId: id })}
      onRefresh={() => {
        if (inFlight.current) return;
        setRefreshing(true);
        read();
      }}
    />
  );
}
