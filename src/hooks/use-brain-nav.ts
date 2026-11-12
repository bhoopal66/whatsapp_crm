'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { cachedQuery } from '@/lib/client-cache';
import { parseCaseSwitches } from '@/lib/cases/settings-ui';

const TTL_MS = 300_000;

/**
 * Whether the sidebar's Brain row (package 022e) shows: the workspace's
 * second-brain switch (migration 194, Settings -> Cases), read from
 * `GET /api/cases/config/settings`. Asked only for agents and up outside
 * a restricted department (the route 403s anyone else), once per
 * workspace and person, and false until answered or on any error. A
 * switch flipped elsewhere shows after the cache lapses or a reload.
 */
export function useBrainNav(): boolean {
  const { accountId, accountRole, user, salesRestricted, profileLoading } =
    useAuth();
  const userId = user?.id ?? null;
  const asks =
    !profileLoading &&
    !salesRestricted &&
    !!accountId &&
    !!userId &&
    !!accountRole &&
    hasMinRole(accountRole, 'agent');
  const [loaded, setLoaded] = useState<{
    key: string;
    on: boolean;
  } | null>(null);
  const key = `brain-switch:${accountId}:${userId}`;

  useEffect(() => {
    if (!asks) return;
    let cancelled = false;
    cachedQuery(key, TTL_MS, async () => {
      const res = await fetch('/api/cases/config/settings');
      if (!res.ok) throw new Error(`brain switch ${res.status}`);
      return parseCaseSwitches(await res.json())?.brainEnabled === true;
    })
      .catch(() => false)
      .then((on) => {
        if (!cancelled) setLoaded({ key, on });
      });
    return () => {
      cancelled = true;
    };
  }, [asks, key]);

  return asks && loaded?.key === key && loaded.on;
}
