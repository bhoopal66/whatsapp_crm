'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  receivesShares,
  sharedBankByConversation,
} from '@/lib/coordinators/ui';
import { createClient } from '@/lib/supabase/client';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * The chats shared with the signed-in person as a coordinator
 * (migration 130): conversation id -> bank code. `null` until known.
 * A role a share gives nothing (admin and up, viewer, guest) gets an
 * empty map without a read. Deliberately uncached: it decides which
 * conversations are listed. Re-read whenever `refreshToken` changes.
 */
export function useMyCoordinatorShares(
  refreshToken = 0
): ReadonlyMap<string, string> | null {
  const { user, accountId, accountRole, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  const eligible = receivesShares(accountRole);
  const [shares, setShares] = useState<ReadonlyMap<string, string> | null>(
    null
  );
  // Bumped when a `conversation_shared` bell arrives, to re-read.
  const [liveToken, setLiveToken] = useState(0);

  useEffect(() => {
    if (profileLoading || !eligible || !userId) return;
    const supabase = createClient();
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
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileLoading, eligible, userId]);

  useEffect(() => {
    if (profileLoading || !eligible || !userId || !accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from('conversation_coordinator_shares')
        .select('conversation_id, bank_code')
        .eq('account_id', accountId)
        .eq('coordinator_user_id', userId)
        .is('revoked_at', null)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (error) {
        // The list still loads; it just lacks the shared chats' labels
        // (and, for a team leader, the shared chats themselves).
        console.error('[inbox] coordinator shares:', error.message);
        setShares(NONE);
        return;
      }
      setShares(sharedBankByConversation(data ?? []));
    })();
    return () => {
      cancelled = true;
    };
  }, [profileLoading, eligible, userId, accountId, refreshToken, liveToken]);

  if (profileLoading) return null;
  if (!eligible) return NONE;
  return shares;
}
