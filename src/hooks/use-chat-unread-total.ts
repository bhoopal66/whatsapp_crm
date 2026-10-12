'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { subscribeChat, unreadCounts, type UnreadCount } from '@/lib/chat';
import { totalUnread } from '@/lib/chat/view';
import { createClient } from '@/lib/supabase/client';

/** Re-read at most this often while chat events stream in. */
const REFRESH_DEBOUNCE_MS = 800;

/**
 * Unread team-chat messages over every channel, for the nav badge. Its
 * own realtime channel (like useTotalUnread): a message or a read
 * marker (a membership UPDATE from chat_mark_read) re-reads the counts,
 * so the SQL stays the one definition of "unread".
 */
export function useChatUnreadTotal(): number {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const [counts, setCounts] = useState<UnreadCount[]>([]);

  useEffect(() => {
    if (!userId || !accountId) return;
    const sb = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      unreadCounts(sb, accountId)
        .then((c) => {
          if (!cancelled) setCounts(c);
        })
        // A badge is not worth an error toast; the next event retries.
        .catch(() => {});
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(load, REFRESH_DEBOUNCE_MS);
    };
    load();
    const unsubscribe = subscribeChat(sb, {
      accountId,
      userId,
      onMessage: schedule,
      onMember: schedule,
      onChannel: schedule,
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [userId, accountId]);

  return totalUnread(counts);
}
