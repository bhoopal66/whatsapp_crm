'use client';

// The chat's team notes (migration 241), loaded once per conversation,
// read again after a gap in realtime (lib/realtime/catch-up.ts) and
// kept live in between (INSERT and UPDATE; realtime does not
// RLS-filter DELETE, so a teammate's delete shows on the next open and
// one's own delete is applied at once). Reads and writes go straight
// to `conversation_notes` under its RLS: the policies decide who reads,
// writes, edits and deletes; the trigger stamps the author and rings
// the mentions.

import { useCallback, useEffect, useRef, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { startLiveRead, type LiveRead } from '@/lib/realtime/catch-up';
import {
  mergeNote,
  type ConversationNote,
  type MentionCandidate,
} from '@/lib/inbox/notes';

const COLUMNS =
  'id, account_id, conversation_id, author_id, body, mention_ids, created_at, edited_at';

// One empty list, so a chat with no notes yet keeps a stable reference.
const NO_NOTES: ConversationNote[] = [];

async function fetchNotes(conversationId: string): Promise<ConversationNote[]> {
  const { data, error } = await createClient()
    .from('conversation_notes')
    .select(COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  // Thrown, not read as "no notes": the notes on screen stay.
  if (error) throw error;
  return (data ?? []) as ConversationNote[];
}

export function useConversationNotes(conversationId: string | null) {
  // Tagged with the conversation it belongs to, so switching chats never
  // shows the previous chat's notes while the new ones load.
  const [state, setState] = useState<{
    conversationId: string | null;
    notes: ConversationNote[];
  }>({ conversationId: null, notes: [] });

  const currentIdRef = useRef(conversationId);
  useEffect(() => {
    currentIdRef.current = conversationId;
  }, [conversationId]);

  const liveRef = useRef<LiveRead | null>(null);

  const apply = useCallback(
    (id: string, update: (notes: ConversationNote[]) => ConversationNote[]) => {
      // A read in flight may be older than this change.
      if (currentIdRef.current === id) liveRef.current?.changed();
      setState((prev) => {
        if (currentIdRef.current !== id) return prev;
        const notes = prev.conversationId === id ? prev.notes : [];
        return { conversationId: id, notes: update(notes) };
      });
    },
    []
  );

  useEffect(() => {
    if (!conversationId) return;
    const live = startLiveRead({
      read: () => fetchNotes(conversationId),
      apply: (notes) => setState({ conversationId, notes }),
    });
    liveRef.current = live;
    const supabase = createClient();
    // A unique topic per subscription (see useConversationEvents).
    const channel = supabase
      .channel(
        `conversation-notes:${conversationId}:${Math.random().toString(36).slice(2)}`
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversation_notes',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          const row = payload.new as ConversationNote;
          if (!row?.id) return;
          apply(conversationId, (notes) => mergeNote(notes, row));
        }
      )
      .subscribe(live.onStatus);
    return () => {
      live.stop();
      liveRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [conversationId, apply]);

  const notes =
    state.conversationId === conversationId ? state.notes : NO_NOTES;

  const add = useCallback(
    async (body: string, mentionIds: string[]): Promise<boolean> => {
      if (!conversationId) return false;
      const { data, error } = await createClient()
        .from('conversation_notes')
        .insert({
          conversation_id: conversationId,
          body,
          mention_ids: mentionIds,
        })
        .select(COLUMNS)
        .single();
      if (error || !data) return false;
      apply(conversationId, (list) =>
        mergeNote(list, data as ConversationNote)
      );
      return true;
    },
    [conversationId, apply]
  );

  const edit = useCallback(
    async (id: string, body: string): Promise<boolean> => {
      if (!conversationId) return false;
      const { data, error } = await createClient()
        .from('conversation_notes')
        .update({ body })
        .eq('id', id)
        .select(COLUMNS)
        .maybeSingle();
      if (error || !data) return false;
      apply(conversationId, (list) =>
        mergeNote(list, data as ConversationNote)
      );
      return true;
    },
    [conversationId, apply]
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (!conversationId) return false;
      const { data, error } = await createClient()
        .from('conversation_notes')
        .delete()
        .eq('id', id)
        .select('id');
      if (error || !data || data.length === 0) return false;
      apply(conversationId, (list) => list.filter((n) => n.id !== id));
      return true;
    },
    [conversationId, apply]
  );

  return { notes, add, edit, remove };
}

/** Who an @mention in this chat's notes may name (241); null: unknown. */
export async function fetchMentionCandidates(
  conversationId: string
): Promise<MentionCandidate[] | null> {
  const { data, error } = await createClient().rpc(
    'conversation_note_mention_candidates',
    { p_conversation_id: conversationId }
  );
  if (error || !Array.isArray(data)) return null;
  return data as MentionCandidate[];
}
