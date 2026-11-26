'use client';

// The open chat's reminder suggestions (migration 197), by message.
// Read once per chat, kept live over realtime and read again after a
// gap in it (lib/realtime/catch-up.ts).

import { useCallback, useEffect, useRef, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { startCatchUp, type LiveRead } from '@/lib/realtime/catch-up';
import {
  REMINDER_SUGGESTION_COLUMNS,
  type ReminderSuggestion,
} from '@/lib/reminders/types';
import {
  mergeLoadedSuggestions,
  withSuggestion,
  withoutSuggestion,
} from '@/lib/reminders/suggestion-view';

const EMPTY_SUGGESTIONS: ReadonlyMap<string, ReminderSuggestion> = new Map();

async function fetchSuggestions(
  conversationId: string
): Promise<Map<string, ReminderSuggestion>> {
  const { data, error } = await createClient()
    .from('message_reminder_suggestions')
    .select(REMINDER_SUGGESTION_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  // Newest first: the first row read for a message wins.
  const map = new Map<string, ReminderSuggestion>();
  for (const row of (data ?? []) as unknown as ReminderSuggestion[]) {
    if (!map.has(row.message_id)) map.set(row.message_id, row);
  }
  return map;
}

export function useReminderSuggestions(
  conversationId: string | undefined,
  on: boolean
) {
  // Kept with the chat it was read for, so a late answer for the chat
  // left behind shows nothing. Never in client-cache / session-cache.
  const [state, setState] = useState<{
    conversationId: string | undefined;
    map: ReadonlyMap<string, ReminderSuggestion>;
    /** Date.now() when the map last changed: the chips' "now". */
    at: number;
  }>(() => ({ conversationId: undefined, map: new Map(), at: 0 }));
  const byMessageId =
    state.conversationId === conversationId ? state.map : EMPTY_SUGGESTIONS;

  useEffect(() => {
    if (!conversationId || !on) return;
    let current = true;
    fetchSuggestions(conversationId).then(
      (map) => {
        if (!current) return;
        // Realtime may have delivered rows while the read was in
        // flight; they are newer than the read, so they win.
        const at = Date.now();
        setState((prev) => ({
          conversationId,
          map: mergeLoadedSuggestions(
            map,
            prev.conversationId === conversationId ? prev.map : new Map()
          ),
          at,
        }));
      },
      // A failed read is no chips, never an error.
      () => {}
    );
    return () => {
      current = false;
    };
  }, [conversationId, on]);

  // "Now" for the chips only moved when the map did, so a chat left
  // open showed "Today 15:00" at 16:00. While any suggestion is held,
  // tick it every minute (rows without one never receive it).
  const hasSuggestions = byMessageId.size > 0;
  useEffect(() => {
    if (!hasSuggestions) return;
    const timer = setInterval(
      () => setState((prev) => ({ ...prev, at: Date.now() })),
      60_000
    );
    return () => clearInterval(timer);
  }, [hasSuggestions, conversationId]);

  const liveRef = useRef<LiveRead | null>(null);
  useEffect(() => {
    if (!conversationId || !on) return;
    // After a gap the rows read replace the map: what it holds is what
    // the gap made stale. Anything newer drops that read (`changed`).
    const live = startCatchUp(
      () => fetchSuggestions(conversationId),
      (map) => setState({ conversationId, map, at: Date.now() })
    );
    liveRef.current = live;
    const supabase = createClient();
    const channel = supabase
      .channel(`reminder-suggestions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_reminder_suggestions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          live.changed();
          const at = Date.now();
          setState((prev) => {
            const base =
              prev.conversationId === conversationId
                ? prev.map
                : EMPTY_SUGGESTIONS;
            if (payload.eventType === 'DELETE') {
              const id = (payload.old as { id?: string } | null)?.id;
              return id
                ? { conversationId, map: withoutSuggestion(base, id), at }
                : prev;
            }
            const row = payload.new as ReminderSuggestion;
            if (row.conversation_id !== conversationId) return prev;
            return { conversationId, map: withSuggestion(base, row), at };
          });
        }
      )
      .subscribe(live.onStatus);
    return () => {
      live.stop();
      liveRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [conversationId, on]);

  /** The row an action answered with, as it now stands. */
  const merge = useCallback((suggestion: ReminderSuggestion) => {
    liveRef.current?.changed();
    const at = Date.now();
    setState((prev) =>
      prev.conversationId === suggestion.conversation_id
        ? {
            conversationId: prev.conversationId,
            map: withSuggestion(prev.map, suggestion),
            at,
          }
        : prev
    );
  }, []);

  return { byMessageId, at: state.at, merge };
}
