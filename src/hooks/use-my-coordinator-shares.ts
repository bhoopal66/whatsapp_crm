'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  receivesShares,
  sharedBankByConversation,
} from '@/lib/coordinators/ui';
import { startCatchUp } from '@/lib/realtime/catch-up';
import { createClient } from '@/lib/supabase/client';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * The chats shared with the signed-in person as a coordinator
 * (migration 133): conversation id -> bank code. `null` until known.
 * A role a share gives nothing (admin and up, viewer, guest) gets an
 * empty map without a read. Deliberately uncached: it decides which
 * conversations are listed. Re-read whenever `refreshToken` changes, and
 * by itself after a gap in realtime.
 */
export function useMyCoordinatorShares(
  refreshToken = 0
): ReadonlyMap<string, string> | null {
  const { user, accountId, accountRole, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  const eligible = receivesShares(accountRole);
  // Keyed by person and workspace: a map read for someone else is never
  // shown, nor kept as the fallback after a failed first read.
  const key = `${userId}:${accountId}`;
  const [read, setRead] = useState<{
    key: string;
    shares: ReadonlyMap<string, string>;
  } | null>(null);
  // Bumped when a `conversation_shared` bell arrives, or may have been
  // missed, to re-read.
  const [liveToken, setLiveToken] = useState(0);

  useEffect(() => {
    if (profileLoading || !eligible || !userId) return;
    const supabase = createClient();
    const live = startCatchUp(() => setLiveToken((n) => n + 1));
    const channel = supabase
      .channel(`coordinator-shares-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          if ((payload.new as { type?: string }).type === 'conversation_shared')
            setLiveToken((n) => n + 1);
        }
      )
      .subscribe(live.onStatus);
    return () => {
      live.stop();
      void supabase.removeChannel(channel);
    };
  }, [profileLoading, eligible, userId]);

  useEffect(() => {
    if (profileLoading || !eligible || !userId || !accountId) return;
    let cancelled = false;
    void (async () => {
      // The RPC, not the table: it drops a share whose bank the person
      // no longer holds, so a removed bank stops showing "Shared".
      const { data, error } = await createClient().rpc('my_coordinator_shares');
      if (cancelled) return;
      if (error) {
        // The list still loads; on a first read it just lacks the shared
        // chats' labels (and, for a team leader, the shared chats).
        console.error('[inbox] coordinator shares:', error.message);
        setRead((prev) =>
          prev && prev.key === key ? prev : { key, shares: NONE }
        );
        return;
      }
      setRead({ key, shares: sharedBankByConversation(data ?? []) });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    profileLoading,
    eligible,
    userId,
    accountId,
    key,
    refreshToken,
    liveToken,
  ]);

  if (profileLoading) return null;
  if (!eligible) return NONE;
  // Nothing read yet: not known. A map read for someone else: none.
  if (!read) return null;
  return read.key === key ? read.shares : NONE;
}
