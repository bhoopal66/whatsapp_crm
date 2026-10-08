'use client';

// ============================================================
// The account's chat tags (migration 075), as every screen that shows
// or edits them reads them.
//
// Slow-moving reference data, so it goes through `cachedQuery` under
// an account-scoped key (see lib/client-cache.ts). `reload()` is what
// a writer calls after a change: it drops the key, reads again and
// hands the fresh list to EVERY mounted consumer — the chat header
// and the chat list are on screen together, and a tag renamed in one
// must not stay stale in the other until the TTL runs out.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ChatTag } from '@/types';
import { createClient } from '@/lib/supabase/client';
import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  chatTagsCacheKey,
  invalidateCached,
} from '@/lib/client-cache';
import { buildChatTagTree, type ChatTagTree } from '@/lib/chat-tags/tree';
import { useAuth } from '@/hooks/use-auth';

interface Loaded {
  accountId: string;
  tags: ChatTag[];
}

type Listener = (loaded: Loaded) => void;

/** Every mounted consumer, so one reload refreshes them all. */
const listeners = new Set<Listener>();

/**
 * Bumped when a reload pushes a fresh list. A first load that started
 * before it carries the older list; if it answers after the push it is
 * dropped. One that answers before the push is simply overwritten by
 * it, and if the reload fails it still lands, rather than leaving its
 * screen with no list at all.
 */
let generation = 0;

/**
 * Read through the cache. A failed read is thrown inside the loader so
 * `cachedQuery` evicts it instead of serving it for the whole TTL, then
 * logged and answered with null.
 */
function loadChatTags(accountId: string): Promise<ChatTag[] | null> {
  return cachedQuery(
    chatTagsCacheKey(accountId),
    REFERENCE_CACHE_TTL_MS,
    async () => {
      const { data, error } = await createClient()
        .from('chat_tags')
        .select('*')
        .eq('account_id', accountId);
      if (error) throw error;
      return (data as ChatTag[] | null) ?? [];
    }
  ).catch((err: unknown) => {
    console.error('[chat-tags] load failed', err);
    return null;
  });
}

export function useChatTags(): {
  /** Null until the first load for the current account. */
  tags: ChatTag[] | null;
  tree: ChatTagTree;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    listeners.add(setLoaded);
    return () => {
      listeners.delete(setLoaded);
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const started = generation;
    loadChatTags(accountId).then((tags) => {
      // A failed first read renders the chats untagged.
      if (!cancelled && started === generation) {
        setLoaded({ accountId, tags: tags ?? [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const reload = useCallback(async () => {
    if (!accountId) return;
    setReloading(true);
    try {
      invalidateCached(chatTagsCacheKey(accountId));
      const tags = await loadChatTags(accountId);
      // A failed read keeps what every screen already shows: pushing []
      // would blank every chat's tags (and offer an admin "Set up chat
      // tags") until the next reload.
      if (!tags) return;
      generation += 1;
      for (const listener of listeners) listener({ accountId, tags });
    } finally {
      setReloading(false);
    }
  }, [accountId]);

  // Another account's list (a user switch without a page load) is not
  // this account's answer.
  const tags = loaded && loaded.accountId === accountId ? loaded.tags : null;
  const tree = useMemo(() => buildChatTagTree(tags ?? []), [tags]);

  return {
    tags,
    tree,
    loading: !!accountId && (tags === null || reloading),
    reload,
  };
}
