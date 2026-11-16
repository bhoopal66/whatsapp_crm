import { REFERENCE_CACHE_TTL_MS, cachedQuery } from '@/lib/client-cache';
import { createClient } from '@/lib/supabase/client';

import { hrMyRoles } from './api';
import type { HrRoles } from './types';

/** The roles question, per account and user (client-cache.ts's rule). */
export function hrRolesCacheKey(accountId: string, userId: string): string {
  return `hr-roles:${accountId}:${userId}`;
}

/**
 * `hr_my_roles()` for this person in this workspace: slow-moving
 * reference data, cached (the chat HR panel and the sidebar share it).
 * Rejects on any error, so a caller treats a failure as "no roles".
 */
export function loadHrRoles(
  accountId: string,
  userId: string
): Promise<HrRoles> {
  return cachedQuery(
    hrRolesCacheKey(accountId, userId),
    REFERENCE_CACHE_TTL_MS,
    async () => {
      const res = await hrMyRoles(createClient());
      if ('error' in res) throw new Error(res.error);
      return res.data;
    }
  );
}
