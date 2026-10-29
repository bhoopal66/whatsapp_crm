'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { HOME_LIST_LIMIT } from '@/lib/dashboard/home/sources';

/** How often the sidebar re-asks; an SLA crosses "overdue" on the clock, not on an event. */
const REFRESH_MS = 2 * 60_000;

/**
 * Open cases past their SLA that this person may read: the sidebar's
 * Cases count, by the home screen's "Overdue cases" rule
 * (`/cases?sla_state=overdue`). Agent and up, as the Cases row; which
 * cases count is `case_inbox`'s call. Read through the route, at most
 * one page (`HOME_LIST_LIMIT`, above the badge's "99+"). Zero until
 * answered and on any error.
 */
export function useCasesOverdue(): number {
  const { accountId, accountRole, profileLoading } = useAuth();
  const eligible =
    !profileLoading && !!accountRole && hasMinRole(accountRole, 'agent');
  const [loaded, setLoaded] = useState<{
    accountId: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!eligible || !accountId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/cases?sla_state=overdue&limit=${HOME_LIST_LIMIT}`,
          { cache: 'no-store' }
        );
        if (!res.ok) return;
        const body = (await res.json()) as { rows?: unknown[] };
        if (!cancelled) setLoaded({ accountId, count: body.rows?.length ?? 0 });
      } catch {
        // A blip keeps the last count; the next tick tries again.
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eligible, accountId]);

  return eligible && loaded?.accountId === accountId ? loaded.count : 0;
}
