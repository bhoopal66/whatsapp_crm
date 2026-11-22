'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { canManageReportAccess, hasMinRole } from '@/lib/auth/roles';
import { cachedQuery } from '@/lib/client-cache';
import { parseReportKeys, type ReportKey } from '@/lib/reports/access';
import { createClient } from '@/lib/supabase/client';

const TTL_MS = 300_000;
const NONE: readonly ReportKey[] = [];

/**
 * The per-person reports the owner granted this person (migration 255),
 * for the sidebar's Reports rows: `report_my_access()` as the caller.
 * Asked only for staff below owner (the owner sees every report without a
 * grant), once per workspace and person, and empty until answered or on
 * any error, so a row a grant would open fails closed. A grant changed
 * elsewhere shows after the cache lapses or a reload. The pages keep their
 * own server-side guard (`ReportAccessLayout`): this only shows the link.
 */
export function useReportNav(): readonly ReportKey[] {
  const { accountId, accountRole, user, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  const asks =
    !profileLoading &&
    !!accountId &&
    !!userId &&
    !!accountRole &&
    hasMinRole(accountRole, 'viewer') &&
    !canManageReportAccess(accountRole);
  const [loaded, setLoaded] = useState<{
    key: string;
    keys: readonly ReportKey[];
  } | null>(null);
  const key = `report-access:${accountId}:${userId}`;

  useEffect(() => {
    if (!asks) return;
    let cancelled = false;
    cachedQuery(key, TTL_MS, async () => {
      const { data, error } = await createClient().rpc('report_my_access');
      if (error) throw error;
      return parseReportKeys(data);
    })
      .catch(() => NONE)
      .then((keys) => {
        if (!cancelled) setLoaded({ key, keys });
      });
    return () => {
      cancelled = true;
    };
  }, [asks, key]);

  return asks && loaded?.key === key ? loaded.keys : NONE;
}
