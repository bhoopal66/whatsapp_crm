'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { messagesByIds, type ChatMessage } from '@/lib/chat';
import { QuoteStore, quoteIds } from '@/lib/chat/quotes';

import { useChatWorkspaceContext } from './chat-context';

/** Quotes are read in one batch once a burst of messages settles. */
const QUOTE_FETCH_DEBOUNCE_MS = 150;

export interface QuoteLookup {
  /** The quoted message; null when unavailable; undefined while loading. */
  get: (id: string) => ChatMessage | null | undefined;
  /** Brings the quoted message into view; absent where it cannot. */
  jump?: (id: string) => void;
}

const QuoteContext = createContext<QuoteLookup>({ get: () => null });

export const QuoteProvider = QuoteContext.Provider;

export function useQuoteLookup(): QuoteLookup {
  return useContext(QuoteContext);
}

/**
 * Resolves a timeline's quotes: from its loaded messages first, else
 * one debounced batch read (messagesByIds) of the missing ids, cached
 * for the channel, each id asked at most once.
 */
export function useQuoteResolver(
  channelId: string,
  messages: readonly ChatMessage[]
): (id: string) => ChatMessage | null | undefined {
  const { sb } = useChatWorkspaceContext();
  // A new store per channel: the cache is the channel's.
  const store = useMemo(
    () => (channelId ? new QuoteStore((ids) => messagesByIds(sb, ids)) : null),
    [sb, channelId]
  );
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!store) return;
    const missing = store.unasked(quoteIds(messages));
    if (missing.length === 0) return;
    // Only the wait is cancelled: a read in flight still lands, or its
    // ids (already asked) would stay "loading" for good.
    const timer = setTimeout(() => {
      void store.request(missing).then((learned) => {
        if (learned) setVersion((v) => v + 1);
      });
    }, QUOTE_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, messages]);

  return useMemo(() => {
    const loaded = new Map(messages.map((m) => [m.id, m]));
    // version: a read landed, so the store answers differently.
    void version;
    return (id: string) => loaded.get(id) ?? store?.get(id);
  }, [messages, store, version]);
}
