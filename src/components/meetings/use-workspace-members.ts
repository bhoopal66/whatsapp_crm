'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { isBankGuest } from '@/lib/auth/roles';
import {
  cachedQuery,
  membersCacheKey,
  REFERENCE_CACHE_TTL_MS,
} from '@/lib/client-cache';
import { resolveMeetingTimeZone } from '@/lib/meetings/schedule';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types';

/**
 * The active workspace's staff, for the invitee picker and for naming
 * the host and invitees. Same cache key, query and shape as the inbox's
 * assign dropdown and the pipelines screen (a bank guest is never
 * listed), so the screens share one round trip.
 */
export function useWorkspaceMembers(): {
  members: Profile[];
  /** auth user id → display name. */
  nameOf: (userId: string) => string | null;
  /** auth user id → avatar picture, when they set one. */
  avatarOf: (userId: string) => string | null;
} {
  const { accountId } = useAuth();
  const [members, setMembers] = useState<Profile[]>([]);

  useEffect(() => {
    if (!accountId) return;
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
  }, [accountId]);

  const nameOf = useMemo(() => {
    const byUser = new Map(
      members.map((p) => [p.user_id, p.full_name || p.email])
    );
    return (userId: string) => byUser.get(userId) ?? null;
  }, [members]);

  const avatarOf = useMemo(() => {
    const byUser = new Map(members.map((p) => [p.user_id, p.avatar_url]));
    return (userId: string) => byUser.get(userId) || null;
  }, [members]);

  return { members, nameOf, avatarOf };
}

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The zone meeting times are shown and entered in: the account's saved
 * one (Team activity settings; `team_activity_limits` is readable by
 * every member), else the viewer's. The viewer's until the read lands,
 * and on a failed read: the zone is presentation only.
 */
export function useMeetingTimeZone(): string {
  const { accountId } = useAuth();
  const [saved, setSaved] = useState<unknown>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    cachedQuery(
      `account-time-zone:${accountId}`,
      REFERENCE_CACHE_TTL_MS,
      async () => {
        const { data, error } = await createClient().rpc(
          'team_activity_limits',
          { p_account: accountId }
        );
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : null;
        return (row as { timezone?: unknown } | null)?.timezone ?? null;
      }
    )
      .then((zone) => {
        if (!cancelled) setSaved(zone);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return resolveMeetingTimeZone(saved, viewerZone());
}
