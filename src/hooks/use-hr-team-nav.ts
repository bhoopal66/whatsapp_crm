'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { loadHrRoles } from '@/lib/hr/roles-cache';
import type { HrRoles } from '@/lib/hr/types';

/**
 * This person's HR roles (migration 200, `hr_my_roles()`), which decide
 * the sidebar's HR rows below admin. Asked once per workspace and person
 * through the cache the chat HR panel shares; null while the profile
 * loads, for a bank guest, until answered and on any error. A restricted
 * department still asks: HR people are in one.
 */
export function useHrTeamNav(): HrRoles | null {
  const { accountId, user, profileLoading, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const asks = !profileLoading && !isBankGuest && !!accountId && !!userId;
  const key = `${accountId}:${userId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    roles: HrRoles | null;
  } | null>(null);

  useEffect(() => {
    if (!asks || !accountId || !userId) return;
    let cancelled = false;
    loadHrRoles(accountId, userId)
      .catch(() => null)
      .then((roles) => {
        if (!cancelled) setLoaded({ key, roles });
      });
    return () => {
      cancelled = true;
    };
  }, [asks, accountId, userId, key]);

  return asks && loaded?.key === key ? loaded.roles : null;
}
