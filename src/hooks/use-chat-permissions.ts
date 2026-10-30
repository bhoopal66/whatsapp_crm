'use client';

// ============================================================
// The caller's team-chat permissions (migration 157), as every chat
// screen that gates a control reads them.
//
// Same shape as use-chat-tags.ts: a cached read under a key naming the
// account AND the user (the answer is the caller's role there), and a
// module-level listener set so `reload()` — what the permissions panel
// calls after a save — refreshes every mounted consumer at once.
//
// `myPermissions` never throws: a failed read answers ALL_ALLOWED
// (the database re-checks every action anyway), so that is also what
// gets cached for the TTL.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  chatPermissionsCacheKey,
  invalidateCached,
} from '@/lib/client-cache';
import { myPermissions } from '@/lib/chat/api';
import { ALL_ALLOWED, type ChatPermissions } from '@/lib/chat/permissions';
import { useAuth } from '@/hooks/use-auth';

interface Loaded {
  key: string;
  permissions: ChatPermissions;
}

type Listener = (loaded: Loaded) => void;

/** Every mounted consumer, so one reload refreshes them all. */
const listeners = new Set<Listener>();

/**
 * Bumped when a reload pushes fresh permissions: a first load that
 * started before it and answers after it is dropped.
 */
let generation = 0;

function loadPermissions(
  accountId: string,
  userId: string
): Promise<ChatPermissions> {
  return cachedQuery(
    chatPermissionsCacheKey(accountId, userId),
    REFERENCE_CACHE_TTL_MS,
    () => myPermissions(createClient(), accountId)
  );
}

export function useChatPermissions(): {
  /** ALL_ALLOWED until the first load for this account and user. */
  permissions: ChatPermissions;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const key =
    accountId && userId ? chatPermissionsCacheKey(accountId, userId) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    listeners.add(setLoaded);
    return () => {
      listeners.delete(setLoaded);
    };
  }, []);

  useEffect(() => {
    if (!accountId || !userId || !key) return;
    let cancelled = false;
    const started = generation;
    loadPermissions(accountId, userId).then((permissions) => {
      if (!cancelled && started === generation) {
        setLoaded({ key, permissions });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, userId, key]);

  const reload = useCallback(async () => {
    if (!accountId || !userId || !key) return;
    setReloading(true);
    try {
      invalidateCached(key);
      const permissions = await loadPermissions(accountId, userId);
      generation += 1;
      for (const listener of listeners) listener({ key, permissions });
    } finally {
      setReloading(false);
    }
  }, [accountId, userId, key]);

  // Another account's or user's answer is not this one's.
  const current = loaded && loaded.key === key ? loaded.permissions : null;

  return {
    permissions: current ?? ALL_ALLOWED,
    loading: key !== null && (current === null || reloading),
    reload,
  };
}
