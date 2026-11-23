'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { loadHrRoles } from '@/lib/hr/roles-cache';
import type { HrRoles } from '@/lib/hr/types';

export interface HrRolesState {
  /** Null while the profile loads, for a bank guest, until answered and on an error. */
  roles: HrRoles | null;
  /** The last read ended in an error (and not merely still loading). */
  failed: boolean;
  /** Ask again after an error. */
  retry: () => void;
}

/**
 * This person's HR roles (migration 200, `hr_my_roles()`), which decide
 * the sidebar's HR row below admin and the HR tabs. Asked once per
 * workspace and person through the cache the chat HR panel shares (a
 * failed read is not cached). A restricted department still asks: HR
 * people are in one.
 */
export function useHrRolesState(): HrRolesState {
  const { accountId, user, profileLoading, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const asks = !profileLoading && !isBankGuest && !!accountId && !!userId;
  const key = `${accountId}:${userId}`;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    attempt: number;
    roles: HrRoles | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!asks || !accountId || !userId) return;
    let cancelled = false;
    loadHrRoles(accountId, userId)
      .then((roles) => ({ roles: roles as HrRoles | null, failed: false }))
      .catch(() => ({ roles: null, failed: true }))
      .then((result) => {
        if (!cancelled) setLoaded({ key, attempt, ...result });
      });
    return () => {
      cancelled = true;
    };
  }, [asks, accountId, userId, key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const current =
    asks && loaded?.key === key && loaded.attempt === attempt ? loaded : null;
  return {
    roles: current?.roles ?? null,
    failed: current?.failed ?? false,
    retry,
  };
}

/** {@link useHrRolesState}'s roles alone, for the menus. */
export function useHrTeamNav(): HrRoles | null {
  return useHrRolesState().roles;
}
