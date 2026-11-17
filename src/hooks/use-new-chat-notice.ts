'use client';

// ============================================================
// The workspace's new chat reminder (migration 207), as the inbox
// composer and the New chat dialog read it. Slow-moving reference
// data, so it goes through `cachedQuery` under a key naming the
// account and the person (the RPC answers for the caller). Any failure
// answers the default: on, generic wording, no marketing number.
// ============================================================

import { useEffect, useState } from 'react';

import { REFERENCE_CACHE_TTL_MS, cachedQuery } from '@/lib/client-cache';
import {
  DEFAULT_NEW_CHAT_NOTICE,
  parseNewChatNotice,
  type NewChatNotice,
} from '@/lib/team-activity/new-chat-notice';
import { useAuth } from '@/hooks/use-auth';

export const NEW_CHAT_NOTICE_CACHE_PREFIX = 'new-chat-notice:';

export function newChatNoticeCacheKey(
  accountId: string,
  userId: string
): string {
  return `${NEW_CHAT_NOTICE_CACHE_PREFIX}${accountId}:${userId}`;
}

function loadNewChatNotice(key: string): Promise<NewChatNotice> {
  return cachedQuery(key, REFERENCE_CACHE_TTL_MS, async () => {
    const res = await fetch('/api/team-activity/new-chat-notice', {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`new chat notice: HTTP ${res.status}`);
    const body = (await res.json()) as { notice?: unknown };
    return parseNewChatNotice(body?.notice);
  }).catch((err: unknown) => {
    console.error('[new-chat-notice] load failed', err);
    return { ...DEFAULT_NEW_CHAT_NOTICE };
  });
}

/** `null` until loaded for this account and person. */
export function useNewChatNotice(): NewChatNotice | null {
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const key =
    accountId && userId ? newChatNoticeCacheKey(accountId, userId) : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    notice: NewChatNotice;
  } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    loadNewChatNotice(key).then((notice) => {
      if (!cancelled) setLoaded({ key, notice });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Another account's or person's answer is not this one's.
  return loaded && loaded.key === key ? loaded.notice : null;
}
