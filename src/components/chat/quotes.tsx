'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
 * for the channel and kept current from the workspace's message events.
 * A failed read is retried after QUOTE_RETRY_DELAYS_MS, then shown as
 * unavailable rather than loading for good.
 */
export function useQuoteResolver(
  channelId: string,
  messages: readonly ChatMessage[]
): (id: string) => ChatMessage | null | undefined {
  const { sb, listen } = useChatWorkspaceContext();
  // A new store per channel: the cache is the channel's.
  const store = useMemo(
    () => (channelId ? new QuoteStore((ids) => messagesByIds(sb, ids)) : null),
    [sb, channelId]
  );
  // Bumped when the store answers differently or a read is due again.
  const [version, setVersion] = useState(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), [store]);

  // The workspace's one subscription: an edit, removal or erasure of a
  // quoted message shows in every quote of it.
  useEffect(() => {
    if (!store) return;
    return listen((e) => {
      if (e.kind !== 'message') return;
      const changed =
        e.event.type === 'delete'
          ? store.invalidate(e.event.id)
          : store.patch(e.event.message);
      if (changed) setVersion((v) => v + 1);
    });
  }, [listen, store]);

  useEffect(() => {
    if (!store) return;
    const missing = store.unasked(quoteIds(messages));
    if (missing.length === 0) return;
    // Only the wait is cancelled: a read in flight still lands, or its
    // ids (already asked) would stay "loading" for good.
    const timer = setTimeout(() => {
      void store.request(missing).then((learned) => {
        if (learned) setVersion((v) => v + 1);
        const wait = store.retryDelay(missing);
        if (wait === null) return;
        clearTimeout(retry.current);
        retry.current = setTimeout(() => setVersion((v) => v + 1), wait);
      });
    }, QUOTE_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, messages, version]);

  return useMemo(() => {
    const loaded = new Map(messages.map((m) => [m.id, m]));
    // version: a read landed, so the store answers differently.
    void version;
    return (id: string) => loaded.get(id) ?? store?.get(id);
  }, [messages, store, version]);
}
