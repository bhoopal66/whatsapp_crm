'use client';

import { useEffect, useRef, useState } from 'react';

import { cachedQuery, invalidateCached } from '@/lib/client-cache';
import { createClient } from '@/lib/supabase/client';
import {
  parseMyOutreachDay,
  type MyOutreachDay,
} from '@/lib/team-activity/thread-guard';

/** Short: the counts move with every new chat this person starts. */
const TTL_MS = 30_000;
const KEY_PREFIX = 'team-activity:my-day:';

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function loadMyDay(): Promise<MyOutreachDay | null> {
  const { data, error } = await createClient().rpc('team_activity_my_day', {
    p_tz: viewerZone(),
  });
  // Before migration 068, or any other failure: no warnings, never an error.
  if (error) return null;
  return parseMyOutreachDay(data);
}

/**
 * Today's outreach figures for the signed-in person (migration 068):
 * how many chats they started, how many each number started, and the
 * limits. `refreshKey` re-reads past the cache — pass something that
 * changes after a send.
 */
export function useMyOutreach(
  userId: string | null | undefined,
  refreshKey: unknown
): MyOutreachDay | null {
  const [day, setDay] = useState<{
    user: string;
    value: MyOutreachDay | null;
  } | null>(null);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const key = `${KEY_PREFIX}${userId}`;
    // A changed refreshKey means "something was sent": read past the cache.
    if (lastRefresh.current !== refreshKey) {
      lastRefresh.current = refreshKey;
      invalidateCached(key);
    }
    void cachedQuery(key, TTL_MS, loadMyDay)
      .then((value) => {
        if (!cancelled) setDay({ user: userId, value });
      })
      .catch(() => {
        if (!cancelled) setDay({ user: userId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, refreshKey]);

  return day && day.user === userId ? day.value : null;
}

/** Forget the cached figures, e.g. after this person sends. */
export function invalidateMyOutreach(userId: string): void {
  invalidateCached(`${KEY_PREFIX}${userId}`);
}
