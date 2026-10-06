'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { cachedQuery } from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';

/**
 * Cache-key prefix; Settings → AI drops it after a save so the lists
 * follow the bot's switch without waiting out the TTL.
 */
export const AI_AUTO_REPLY_LIVE_CACHE_PREFIX = 'ai-auto-reply-live:';

/**
 * Whether the AI auto-reply is live on the signed-in user's account
 * (migration 067's `ai_auto_reply_live()`); null until known.
 *
 * Decides which list a campaign chat is in — see `inCampaignInbox`.
 * Asked as soon as the session is known rather than after the profile,
 * so the inbox does not wait on one more round trip. A failed read
 * answers false: nothing is the bot's, so every chat shows in the
 * Inbox, which is the safe side.
 */
export function useAiAutoReplyLive(): boolean | null {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    cachedQuery(
      `${AI_AUTO_REPLY_LIVE_CACHE_PREFIX}${userId}`,
      60_000,
      async () => {
        const { data, error } = await createClient().rpc('ai_auto_reply_live');
        if (error) throw error;
        return data === true;
      }
    )
      .catch(() => false)
      .then((value) => {
        if (!cancelled) setLive(value);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return live;
}
