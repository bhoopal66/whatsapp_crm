'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { hasHrAccess } from '@/lib/hr/access';
import { loadHrRoles } from '@/lib/hr/roles-cache';

/**
 * Whether this person is on an HR team (migration 200, `hr_my_roles()`),
 * which shows them the sidebar's HR inbox row below admin. Asked once
 * per workspace and person through the cache the chat HR panel shares;
 * false while the profile loads, for a bank guest, until answered and on
 * any error. A restricted department still asks: HR people are in one.
 */
export function useHrTeamNav(): boolean {
  const { accountId, user, profileLoading, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const asks = !profileLoading && !isBankGuest && !!accountId && !!userId;
  const key = `${accountId}:${userId}`;
  const [loaded, setLoaded] = useState<{ key: string; on: boolean } | null>(
    null
  );

  useEffect(() => {
    if (!asks || !accountId || !userId) return;
    let cancelled = false;
    loadHrRoles(accountId, userId)
      .then(hasHrAccess)
      .catch(() => false)
      .then((on) => {
        if (!cancelled) setLoaded({ key, on });
      });
    return () => {
      cancelled = true;
    };
  }, [asks, accountId, userId, key]);

  return asks && loaded?.key === key && loaded.on;
}
