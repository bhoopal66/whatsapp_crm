'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { presenceByUser, type UserPresence } from '@/lib/pbx/calls';
import {
  applyPhoneChange,
  mergePhoneSnapshot,
  samePhonePresence,
  type PhonePresenceRow,
  type PhoneRows,
} from '@/lib/person-presence';
import { createClient } from '@/lib/supabase/client';

/** Phone presence by lower-cased user id; empty without a PBX. */
export type PhonePresence = Readonly<Record<string, UserPresence>>;

/** The fallback read, for a realtime event the socket dropped. */
const POLL_MS = 60_000;
/** A row turns stale (offline) on the clock alone, with no event. */
const RE_DERIVE_MS = 30_000;

const EMPTY: PhonePresence = Object.freeze({});

interface Store {
  rows: PhoneRows;
  byUser: PhonePresence;
  listeners: Set<() => void>;
  refs: number;
  stop: () => void;
}

// One store per signed-in person and workspace, alive only while a dot
// is mounted: every dot on a page shares its one realtime channel and
// poll, and its rows are dropped with the last of them, so nothing
// outlives the session it was read in (no client-cache here).
const stores = new Map<string, Store>();
let topicSeq = 0;

function start(store: Store, accountId: string): () => void {
  const sb = createClient();
  let stopped = false;
  const derive = () => {
    const rows = [...store.rows.values()].map((r) => ({
      ...r,
      user_id: r.user_id?.toLowerCase() ?? null,
    }));
    const next = presenceByUser(rows, Date.now());
    if (samePhonePresence(store.byUser, next)) return;
    store.byUser = next;
    store.listeners.forEach((fn) => fn());
  };
  const publish = (rows: PhoneRows) => {
    if (stopped || rows === store.rows) return;
    store.rows = rows;
    derive();
  };

  // Subscribe first, then read: the read merges, keeping any newer row
  // an event delivered meanwhile. A fresh topic each time, because
  // supabase.channel(name) hands back a channel still being removed.
  const channel = sb
    .channel(`phone-presence:${accountId}:${++topicSeq}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'pbx_presence',
        filter: `account_id=eq.${accountId}`,
      },
      (payload) => publish(applyPhoneChange(store.rows, payload))
    )
    .subscribe();
  const read = async () => {
    const { data, error } = await sb
      .from('pbx_presence')
      .select(
        'connection_id, extension, user_id, presence, call_state, updated_at'
      )
      .eq('account_id', accountId);
    if (error) return; // the next poll or event catches up
    publish(mergePhoneSnapshot(store.rows, (data ?? []) as PhonePresenceRow[]));
  };
  void read();
  const poll = setInterval(() => void read(), POLL_MS);
  const tick = setInterval(derive, RE_DERIVE_MS);
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(tick);
    void sb.removeChannel(channel);
  };
}

function acquire(key: string, accountId: string): Store {
  let store = stores.get(key);
  if (!store) {
    store = {
      rows: new Map(),
      byUser: EMPTY,
      listeners: new Set(),
      refs: 0,
      stop: () => {},
    };
    stores.set(key, store);
  }
  store.refs += 1;
  if (store.refs === 1) store.stop = start(store, accountId);
  return store;
}

function release(key: string) {
  const store = stores.get(key);
  if (!store) return;
  store.refs -= 1;
  if (store.refs > 0) return;
  store.stop();
  stores.delete(key);
}

/**
 * Live phone presence (pbx_presence, migration 089) for the active
 * workspace: a realtime subscription (pbx_presence_select replays RLS
 * per subscriber: the active account's rows) plus a fallback read every
 * minute. Combine it with app presence through `personPresence`.
 * Off for a bank guest, whom RLS gives no rows anyway.
 */
export function usePhonePresence(enabled = true): PhonePresence {
  const { user, accountId, isBankGuest } = useAuth();
  const userId = user?.id ?? null;
  const key =
    enabled && userId && accountId && !isBankGuest
      ? `${userId}:${accountId}`
      : null;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key || !accountId) return () => {};
      const store = acquire(key, accountId);
      store.listeners.add(onChange);
      return () => {
        store.listeners.delete(onChange);
        release(key);
      };
    },
    [key, accountId]
  );
  const snapshot = useCallback(
    () => (key ? (stores.get(key)?.byUser ?? EMPTY) : EMPTY),
    [key]
  );
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
