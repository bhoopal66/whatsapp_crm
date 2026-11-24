'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { onSubmissionGroupRead } from '@/lib/submission-groups/mark-read';
import { createClient } from '@/lib/supabase/client';
import { visibleInterval } from '@/lib/visible-interval';

const POLL_MS = 60_000;

/**
 * The number of inbound submission group messages the signed-in person
 * has not read (migration 173, `sg_unread_count`), across the ACTIVE
 * groups of the active workspace they can see. Unlike `useGroupsUnread`
 * it counts messages, not groups. The sidebar shows it on the Submission
 * groups entry.
 *
 * Polled, not live, for the reason `useGroupsUnread` gives. Marking a
 * group read in this tab (`markSubmissionGroupRead`) refetches at once.
 * Only agents and up ask (the entry's `minRole` and the route's
 * AgentOnlyLayout): a viewer or a bank guest has no link to put it on.
 * 0 until the first answer and with no workspace; a failed poll keeps
 * the last count.
 */
export function useSubmissionGroupsUnread(): number {
  const { accountId, accountRole } = useAuth();
  const [count, setCount] = useState(0);
  const allowed = !!accountRole && hasMinRole(accountRole, 'agent');

  useEffect(() => {
    if (!accountId || !allowed) return;
    const supabase = createClient();
    let cancelled = false;
    // Only the latest request may set the count: a poll that started
    // before a mark-read committed can answer after the refresh that
    // followed it, and would put the old count back for a minute.
    let seq = 0;

    const refresh = async () => {
      const mine = ++seq;
      try {
        const { data, error } = await supabase.rpc('sg_unread_count');
        if (cancelled || mine !== seq) return;
        if (!error && typeof data === 'number') setCount(data);
      } catch {
        // A blip keeps the last count; the next poll tries again.
      }
    };

    void refresh();
    const stop = visibleInterval(refresh, POLL_MS);
    const off = onSubmissionGroupRead(() => void refresh());
    return () => {
      cancelled = true;
      stop();
      off();
      // A workspace switch must not show the old workspace's count.
      setCount(0);
    };
  }, [accountId, allowed]);

  return !accountId || !allowed ? 0 : count;
}
