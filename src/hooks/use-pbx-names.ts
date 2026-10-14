'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { cachedQuery } from '@/lib/client-cache';
import { createClient } from '@/lib/supabase/client';

type Client = ReturnType<typeof createClient>;

/**
 * The active workspace's people by auth user id → name, for the call
 * screens (the incoming-call card, the Colleagues tab). One cache entry
 * per workspace, shared by every caller, for five minutes.
 */
export function loadPbxNames(
  supabase: Client,
  accountId: string
): Promise<Record<string, string>> {
  return cachedQuery(`pbx-names:${accountId}`, 300_000, async () => {
    const { data } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId);
    return Object.fromEntries(
      ((data ?? []) as { user_id: string; full_name: string }[]).map((p) => [
        p.user_id,
        p.full_name,
      ])
    );
  });
}

/** loadPbxNames for the active workspace, with or without an extension. */
export function usePbxNames(): Record<string, string> {
  const { accountId } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [loaded, setLoaded] = useState<{
    accountId: string;
    names: Record<string, string>;
  } | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void loadPbxNames(supabase, accountId)
      .then((names) => live && setLoaded({ accountId, names }))
      .catch(() => {}); // evicted from the cache; the next mount retries
    return () => {
      live = false;
    };
  }, [supabase, accountId]);
  return loaded && loaded.accountId === accountId ? loaded.names : EMPTY;
}

const EMPTY: Record<string, string> = Object.freeze({}) as Record<
  string,
  string
>;
