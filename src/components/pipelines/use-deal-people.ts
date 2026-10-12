'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  cachedQuery,
  REFERENCE_CACHE_TTL_MS,
  membersCacheKey,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { canLeadTeam, hasMinRole, isBankGuest } from '@/lib/auth/roles';
import type { DealPeopleInput } from '@/lib/pipelines/owner';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types';

const NO_ONE: ReadonlySet<string> = new Set();

/**
 * The people the pipelines screen and the deal form reason about: the
 * signed-in member, the account's members, and whom they lead. Both
 * reads go through the same cache keys (and shapes) as the inbox's
 * assign dropdown, so neither costs a round trip there twice.
 */
export function useDealPeople(
  enabled = true
): DealPeopleInput<Profile> & { members: Profile[] } {
  const { accountRole, accountId, user } = useAuth();
  const [members, setMembers] = useState<Profile[]>([]);
  const [ledUserIds, setLedUserIds] = useState<ReadonlySet<string>>(NO_ONE);

  // The active workspace only (RLS also returns the caller's own row in
  // every other one), and a bank guest is never listed.
  useEffect(() => {
    if (!enabled || !accountId) return;
    let cancelled = false;
    (async () => {
      const data = await cachedQuery(
        membersCacheKey(accountId),
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const { data, error } = await createClient()
            .from('profiles')
            .select('*')
            .eq('account_id', accountId)
            .order('full_name');
          if (error) {
            console.error('Failed to fetch profiles:', error);
            return [] as Profile[];
          }
          return ((data as Profile[] | null) ?? []).filter(
            (p) => !isBankGuest(p.account_role)
          );
        }
      ).catch(() => [] as Profile[]);
      if (!cancelled) setMembers(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, accountId]);

  // Only a team leader needs the roster: an admin already reaches
  // everyone, anyone else only themselves.
  const leads =
    !!accountRole &&
    canLeadTeam(accountRole) &&
    !hasMinRole(accountRole, 'admin');
  const leaderId = leads ? (user?.id ?? null) : null;
  useEffect(() => {
    if (!enabled || !leaderId) return;
    let cancelled = false;
    (async () => {
      const ids = await cachedQuery(
        teamRosterCacheKey(leaderId),
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const { data, error } = await createClient()
            .from('teams')
            .select('team_members(user_id)')
            .eq('leader_user_id', leaderId);
          if (error || !data) return null;
          const found = new Set<string>();
          for (const team of data as {
            team_members: { user_id: string }[] | null;
          }[]) {
            for (const m of team.team_members ?? []) found.add(m.user_id);
          }
          return found;
        }
      ).catch(() => null);
      if (!cancelled && ids) setLedUserIds(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, leaderId]);

  return {
    role: accountRole,
    me: members.find((p) => p.user_id === user?.id) ?? null,
    members,
    ledUserIds: leaderId ? ledUserIds : NO_ONE,
  };
}
