'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { onGroupRead } from '@/lib/groups/mark-read';
import { createClient } from '@/lib/supabase/client';
import { visibleInterval } from '@/lib/visible-interval';

const POLL_MS = 60_000;

/**
 * The number of WhatsApp groups with an inbound message the signed-in
 * person has not read (migration 146, `whatsapp_group_unread_count`):
 * groups of the active workspace they can see, not left, with a
 * message newer than their read marker. The sidebar shows it on the
 * Groups entry.
 *
 * Polled, not live: the count is one cheap RPC, and a realtime channel
 * on every group message of the workspace would replay RLS per
 * subscriber for a number that may lag a minute. Marking a group read
 * in this tab (`markGroupRead`) refetches at once. It sleeps while the
 * tab is hidden. 0 until the first answer, with no workspace and for a
 * bank guest (they see no group); a failed poll keeps the last count.
 */
export function useGroupsUnread(): number {
  const { accountId, isBankGuest } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!accountId || isBankGuest) return;
    const supabase = createClient();
    let cancelled = false;
    // Only the latest request may set the count: a poll that started
    // before a mark-read committed can answer after the refresh that
    // followed it, and would put the old count back for a minute.
    let seq = 0;

    const refresh = async () => {
      const mine = ++seq;
      try {
        const { data, error } = await supabase.rpc(
          'whatsapp_group_unread_count'
        );
        if (cancelled || mine !== seq) return;
        if (!error && typeof data === 'number') setCount(data);
      } catch {
        // A blip keeps the last count; the next poll tries again.
      }
    };

    void refresh();
    const stop = visibleInterval(refresh, POLL_MS);
    const off = onGroupRead(() => void refresh());
    return () => {
      cancelled = true;
      stop();
      off();
      // A workspace switch must not show the old workspace's count.
      setCount(0);
    };
  }, [accountId, isBankGuest]);

  return !accountId || isBankGuest ? 0 : count;
}
