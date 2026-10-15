'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { isBankGuest } from '@/lib/auth/roles';
import {
  cachedQuery,
  membersCacheKey,
  REFERENCE_CACHE_TTL_MS,
} from '@/lib/client-cache';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types';

/**
 * auth user id → display name, for the room's tiles. The cache entry is
 * shared with the inbox's assign dropdown and the /meetings screens, so
 * the query and the stored shape (staff `Profile[]`) must stay theirs.
 */
export function useMemberNames(): (userId: string) => string | null {
  const { accountId } = useAuth();
  const [members, setMembers] = useState<Profile[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void cachedQuery(
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
    )
      .catch(() => [] as Profile[])
      .then((data) => {
        if (!cancelled) setMembers(data);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return useMemo(() => {
    const byUser = new Map(
      members.map((p) => [p.user_id, p.full_name || p.email])
    );
    return (userId: string) => byUser.get(userId) ?? null;
  }, [members]);
}
