"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useAuth } from "@/hooks/use-auth";
import { scopedChangeBindings } from "@/lib/realtime/scoped-changes";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const { accountId } = useAuth();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    // Conversations are scoped to the active account (RLS shows nothing
    // else), so Realtime neither checks nor ships other workspaces' rows.
    // Unknown account: no channel, never an unfiltered one. A workspace
    // switch changes `accountId`, which re-subscribes with the new filter.
    const conversationBindings = scopedChangeBindings(
      "conversations",
      "account_id",
      accountId
    );
    if (!conversationBindings) return;

    const supabase = createClient();

    // Messages stay unfiltered: no single column scopes them. The topic
    // names the account because removeChannel is async, and a re-run on
    // the same topic would be handed the channel still leaving.
    let channel = supabase
      .channel(`${channelName}:${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      );
    for (const binding of conversationBindings) {
      channel = channel.on("postgres_changes", binding, (payload) => {
        onConversationRef.current?.({
          eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
          new: payload.new as Conversation,
          old: payload.old as Partial<Conversation>,
        });
      });
    }
    channel.subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled, accountId]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
