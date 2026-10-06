'use client';

// ============================================================
// The account's WhatsApp numbers, and which of them the signed-in
// user is allocated to (migration 060) — as the browser may see them,
// no credentials.
//
// Both are slow-moving reference data (they change when an admin edits
// Settings → Numbers & access, which drops these keys), so they go
// through `cachedQuery`. Keys name the question including the account
// and, for allocations, the user — see lib/client-cache.ts.
// ============================================================

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { cachedQuery } from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';

export interface AccountNumber {
  id: string;
  provider: 'whapi' | 'meta';
  label: string | null;
  /** Whapi: the connected phone number. Meta: the WABA id. */
  waba_id: string | null;
  phone_number_id: string;
  is_primary: boolean;
  status: string;
}

/**
 * Every number on the account, oldest first; null until loaded.
 *
 * `refreshKey` re-reads whenever it changes, still through the cache.
 * The inbox stays mounted for a whole shift, and `status` is what warns
 * an agent that a number has dropped (the health monitor keeps it
 * current). A read that happened only on mount would miss the drop.
 */
export function useAccountNumbers(
  enabled = true,
  refreshKey?: string | number
): AccountNumber[] | null {
  const { accountId } = useAuth();
  const [numbers, setNumbers] = useState<AccountNumber[] | null>(null);

  useEffect(() => {
    if (!accountId || !enabled) return;
    let cancelled = false;
    cachedQuery(`whatsapp-channels:${accountId}`, 60_000, async () => {
      // Every row, not just `connected` ones — `loadChannels`
      // server-side doesn't filter by status either, and callers use
      // this to predict what the server will actually do.
      const { data } = await createClient()
        .from('whatsapp_config')
        .select(
          'id, provider, label, waba_id, phone_number_id, is_primary, status'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: true });
      return (data ?? []) as AccountNumber[];
    })
      .catch(() => [] as AccountNumber[])
      .then((rows) => {
        if (!cancelled) setNumbers(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, enabled, refreshKey]);

  return numbers;
}

/** Ids of the numbers the signed-in user is allocated to; null until loaded. */
export function useMyNumberIds(): string[] | null {
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!accountId || !userId) return;
    let cancelled = false;
    cachedQuery(
      `whatsapp-allocations:${accountId}:${userId}`,
      60_000,
      async () => {
        const { data } = await createClient()
          .from('whatsapp_channel_members')
          .select('config_id')
          .eq('account_id', accountId)
          .eq('user_id', userId);
        return ((data ?? []) as Array<{ config_id: string }>).map(
          (r) => r.config_id
        );
      }
    )
      .catch(() => [] as string[])
      .then((rows) => {
        if (!cancelled) setIds(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, userId]);

  return ids;
}

/**
 * The number a provider-pinned send from the Contact screen will use.
 * Mirrors `pickByProvider` server-side: the thread's own number, then
 * one the user is allocated to, then the default, then the oldest.
 */
export function predictNumber(
  numbers: AccountNumber[],
  provider: 'whapi' | 'meta',
  preferIds: ReadonlyArray<string | null | undefined>
): AccountNumber | null {
  const candidates = numbers.filter((n) => n.provider === provider);
  if (candidates.length === 0) return null;
  for (const id of preferIds) {
    const hit = id ? candidates.find((n) => n.id === id) : undefined;
    if (hit) return hit;
  }
  return candidates.find((n) => n.is_primary) ?? candidates[0];
}

/**
 * Every allocation on the account (who is on which number); null until
 * loaded. The thread's number picker needs all of them, not just the
 * user's own, to tell a shared number (nobody on it) from someone
 * else's — see `usableNumbers`.
 */
export function useAllNumberAllocations(): Array<{
  config_id: string;
  user_id: string;
}> | null {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<Array<{
    config_id: string;
    user_id: string;
  }> | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    cachedQuery(`whatsapp-allocations:${accountId}:all`, 60_000, async () => {
      const { data } = await createClient()
        .from('whatsapp_channel_members')
        .select('config_id, user_id')
        .eq('account_id', accountId);
      return (data ?? []) as Array<{ config_id: string; user_id: string }>;
    })
      .catch(() => [] as Array<{ config_id: string; user_id: string }>)
      .then((r) => {
        if (!cancelled) setRows(r);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return rows;
}
