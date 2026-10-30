'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { channelRestrictions, type ChannelRestriction } from '@/lib/chat';
import {
  activeRestrictions,
  nextRestrictionEnd,
  upsertRestriction,
} from '@/lib/chat/moderation';

import { useChatWorkspaceContext } from './chat-context';

/** setTimeout's ceiling; a longer timeout re-arms when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Reads in flight, so the composer, thread panel and members panel that
 * open together share one request. Not a cache: an entry lives only
 * until its read settles. Keyed by viewer too, since RLS shapes the rows.
 */
const inFlight = new Map<string, Promise<ChannelRestriction[]>>();

function readRestrictions(
  sb: SupabaseClient,
  channelId: string,
  viewer: string
): Promise<ChannelRestriction[]> {
  const key = `${viewer}:${channelId}`;
  const held = inFlight.get(key);
  if (held) return held;
  const p = channelRestrictions(sb, channelId).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, p);
  return p;
}

interface State {
  channelId: string;
  rows: readonly ChannelRestriction[];
  /** The clock "in force" is judged by; set with the rows and at expiry. */
  now: number;
}

export interface ChannelRestrictions {
  /** Timeouts in force: lower-cased user id → until. Empty until loaded. */
  active: ReadonlyMap<string, string>;
  /** Re-reads the channel's rows (after a restrict or lift made here). */
  refresh: () => Promise<void>;
}

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * One channel's posting timeouts (160, chat_channel_restrictions): the
 * rows RLS hands the viewer (their own, or every one when they can
 * manage the channel), kept live from the workspace's single realtime
 * subscription (`listen`, kind 'restriction'). Re-renders when the
 * soonest timeout runs out, so a block lifts by itself.
 */
export function useChannelRestrictions(
  channelId: string | null
): ChannelRestrictions {
  const { sb, listen, userId } = useChatWorkspaceContext();
  const viewer = userId?.toLowerCase() ?? '';
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!channelId) return;
    let off = false;
    // An event that lands before the first load is dropped, as in
    // useChannelMembers: the load almost always reads after it.
    const unlisten = listen((e) => {
      if (e.kind !== 'restriction') return;
      setState((s) => {
        if (!s || s.channelId !== channelId) return s;
        const rows = upsertRestriction(s.rows, channelId, e.restriction);
        return rows === s.rows ? s : { channelId, rows, now: Date.now() };
      });
    });
    readRestrictions(sb, channelId, viewer)
      .then((rows) => !off && setState({ channelId, rows, now: Date.now() }))
      // No rows read = no timeout shown; the server still refuses.
      .catch(() => {});
    return () => {
      off = true;
      unlisten();
    };
  }, [sb, listen, channelId, viewer]);

  const current = state && state.channelId === channelId ? state : null;
  const active = useMemo(
    () =>
      current
        ? activeRestrictions(current.rows, current.channelId, current.now)
        : NONE,
    [current]
  );

  const soonest = nextRestrictionEnd(active);
  // `now` in the deps: a timer capped at MAX_TIMER_MS re-arms when it fires.
  const now = current?.now;
  useEffect(() => {
    if (soonest === null) return;
    const id = setTimeout(
      () => setState((s) => (s ? { ...s, now: Date.now() } : s)),
      Math.min(Math.max(soonest - Date.now(), 0) + 250, MAX_TIMER_MS)
    );
    return () => clearTimeout(id);
  }, [soonest, now]);

  const refresh = useCallback(async () => {
    if (!channelId) return;
    try {
      // Not through readRestrictions: a read already in flight may have
      // started before the change this refresh is for.
      const rows = await channelRestrictions(sb, channelId);
      setState({ channelId, rows, now: Date.now() });
    } catch {
      // Realtime still brings the change.
    }
  }, [sb, channelId]);

  return { active, refresh };
}
