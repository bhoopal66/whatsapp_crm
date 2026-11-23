'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { useAuth } from '@/hooks/use-auth';
import { loadMemberLoads } from '@/lib/assignment/rotation';
import type { MemberLoad } from '@/lib/assignment/types';
import { loadsByUser } from '@/lib/assignment/ui';
import { cachedQuery } from '@/lib/client-cache';
import { createClient } from '@/lib/supabase/client';

/** Every key this hook caches under; invalidate it after a limit change. */
export const MEMBER_LOADS_CACHE_PREFIX = 'assignment-loads:';

/** Loads change with every assignment, so a short life only. */
const TTL_MS = 15_000;

/** Throws when they were not read: only a rejected load is not cached. */
async function readLoads(db: SupabaseClient): Promise<MemberLoad[]> {
  const loads = await loadMemberLoads(db);
  if (!loads) throw new Error('member loads not read');
  return loads;
}

const EMPTY: ReadonlyMap<string, MemberLoad> = new Map();

/**
 * Open company chats and chat limit per person of the active workspace
 * (assignment_member_loads, migration 236), for the Assign menu. Asked
 * when `active` turns true (the menu opens), so the figures are at most
 * a few seconds old when someone picks a person. The cache key names
 * the workspace and the viewer.
 */
export function useMemberLoads(
  active: boolean
): ReadonlyMap<string, MemberLoad> {
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const supabase = useMemo(() => createClient(), []);
  const [loaded, setLoaded] = useState<{
    key: string;
    loads: ReadonlyMap<string, MemberLoad>;
  } | null>(null);
  const key =
    accountId && userId
      ? `${MEMBER_LOADS_CACHE_PREFIX}${accountId}:${userId}`
      : null;

  useEffect(() => {
    if (!active || !key) return;
    let live = true;
    void cachedQuery(key, TTL_MS, () => readLoads(supabase))
      .then((rows) => {
        if (live) setLoaded({ key, loads: loadsByUser(rows) });
      })
      .catch(() => {
        // No figures rather than those of an earlier opening.
        if (live) setLoaded(null);
      });
    return () => {
      live = false;
    };
  }, [active, key, supabase]);

  return loaded && loaded.key === key ? loaded.loads : EMPTY;
}
