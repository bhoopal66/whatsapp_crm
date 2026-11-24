'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  createThreadStore,
  threadReads,
  type ThreadStore,
  type ThreadView,
} from '@/lib/chat/thread';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

/**
 * The open thread (`lib/chat/thread.ts`), live through the workspace's
 * one subscription and read again after a gap in it.
 */
export function useThread(
  ws: Pick<ChatWorkspace, 'sb' | 'listen' | 'fail'>,
  channelId: string,
  rootId: string
): { store: ThreadStore; view: ThreadView } {
  const { sb, listen, fail } = ws;
  const store = useMemo(
    () =>
      createThreadStore(threadReads(sb, channelId, rootId), channelId, rootId),
    [sb, channelId, rootId]
  );
  const view = useSyncExternalStore(store.subscribe, store.get, store.get);

  useEffect(() => {
    // Listening first: an event during the read is replayed over it.
    const off = listen((e) => {
      if (e.kind === 'resync') {
        // Rejecting is what has the workspace's catch-up try again.
        return store.resync().then((ok) => {
          if (!ok) throw new Error('The thread was not read');
        });
      }
      if (e.kind === 'message')
        store.record({ kind: 'message', event: e.event });
      else if (e.kind === 'reaction')
        store.record({ kind: 'reaction', event: e.event });
    });
    const leave = store.show(fail);
    return () => {
      off();
      leave();
    };
  }, [listen, store, fail]);

  return { store, view };
}
