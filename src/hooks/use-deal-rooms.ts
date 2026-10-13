'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { RoomSummary } from '@/lib/deal-rooms/reads';
import { startGuestRefresh } from '@/lib/deal-rooms/view';
import { createClient } from '@/lib/supabase/client';

const DEBOUNCE_MS = 600;

/**
 * Debounced callback on any change to `table` rows matching `filter`.
 * Realtime only signals; the data is re-read through the API, which
 * names its columns (the column grants refuse `select=*`).
 */
export function useTableSignal(
  sb: SupabaseClient,
  tables: readonly string[],
  filter: (table: string) => string | null,
  onChange: () => void
) {
  const key = tables.map((t) => `${t}:${filter(t)}`).join('|');
  useEffect(() => {
    if (key.includes(':null')) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, DEBOUNCE_MS);
    };
    let ch = sb.channel(`signal:${Math.random().toString(36).slice(2, 10)}`);
    for (const part of key.split('|')) {
      const at = part.indexOf(':');
      ch = ch.on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: part.slice(0, at),
          filter: part.slice(at + 1),
        },
        fire
      );
    }
    const sub = ch.subscribe();
    return () => {
      clearTimeout(timer);
      void sb.removeChannel(sub);
    };
  }, [sb, key, onChange]);
}

/**
 * A bank guest's room screens never get the `deal_rooms` signal (they
 * cannot read that table), so they re-read every minute while mounted.
 * Staff: nothing, the signal serves them.
 */
export function useGuestRefresh(guest: boolean, reload: () => void) {
  useEffect(() => startGuestRefresh(guest, reload), [guest, reload]);
}

/**
 * The deal rooms the viewer can see (GET /api/deal-rooms), kept live: by
 * the realtime signal for staff, by a 60 s refresh for a bank guest.
 */
export function useDealRooms(accountId: string | null, guest = false) {
  const sb = useMemo<SupabaseClient>(() => createClient(), []);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/deal-rooms', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setRooms(((await res.json()) as { rooms: RoomSummary[] }).rooms);
    } catch {
      setRooms((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    if (!accountId) return;
    // setState lands after the fetch, not in the effect body.
    void Promise.resolve().then(reload);
  }, [accountId, reload]);
  useTableSignal(
    sb,
    ['deal_rooms'],
    () => (accountId ? `account_id=eq.${accountId}` : null),
    reload
  );
  useGuestRefresh(guest, reload);
  return { rooms, reload };
}
