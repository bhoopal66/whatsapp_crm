'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { hrCounts } from '@/lib/hr/api';
import type { HrCounts } from '@/lib/hr/types';
import { createClient } from '@/lib/supabase/client';
import { visibleInterval } from '@/lib/visible-interval';

const REFRESH_MS = 60_000;

/**
 * One poll of `hr_counts()` (migration 200) per tab, shared by every
 * mounted consumer (the sidebar's HR group, a list header): the first
 * subscriber starts it, the last one stops it. Keyed by workspace and
 * person, so a switch never shows the previous one's figures.
 */
const store = {
  key: null as string | null,
  counts: null as HrCounts | null,
  listeners: new Set<() => void>(),
  /** Stops the poll; null when none runs. */
  stop: null as (() => void) | null,
  /** Mounted consumers that want the poll running. */
  active: 0,
  seq: 0,
};

function emit() {
  for (const l of store.listeners) l();
}

function poll(key: string) {
  const seq = ++store.seq;
  hrCounts(createClient())
    .then((res) => {
      if (seq !== store.seq || store.key !== key) return;
      // An error keeps the last figures rather than blanking the badges.
      if ('data' in res) {
        store.counts = res.data;
        emit();
      }
    })
    .catch(() => {});
}

function start(key: string) {
  if (store.key !== key) {
    store.key = key;
    store.counts = null;
    store.stop?.();
    store.stop = null;
    emit();
  }
  if (!store.stop) {
    poll(key);
    store.stop = visibleInterval(() => poll(key), REFRESH_MS);
  }
}

function subscribe(listener: () => void) {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/**
 * The HR inboxes' counts over what RLS shows the caller, refreshed
 * every minute; null until answered, while the profile loads, for a
 * bank guest, or when `enabled` is false (no HR access: the RPC would
 * only answer zeros).
 */
export function useHrCounts(enabled = true): HrCounts | null {
  const { accountId, user, profileLoading, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const key =
    enabled && !profileLoading && !isBankGuest && accountId && userId
      ? `${accountId}:${userId}`
      : null;

  useEffect(() => {
    if (!key) return;
    store.active += 1;
    start(key);
    return () => {
      store.active -= 1;
      if (store.active === 0 && store.stop) {
        store.stop();
        store.stop = null;
      }
    };
  }, [key]);

  const snapshot = useSyncExternalStore(
    subscribe,
    () => store.counts,
    () => null
  );
  return key && store.key === key ? snapshot : null;
}
