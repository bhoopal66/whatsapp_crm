'use client';

import { useEffect, useMemo, useState } from 'react';

import { activeTypers, typingIn, type TypingRow } from '@/lib/chat';
import {
  applyTypingChange,
  mergeTypingRead,
  pruneTyping,
} from '@/lib/chat/typing-flow';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

const TICK_MS = 1000;
const NONE: readonly TypingRow[] = [];

/**
 * Who else is typing in a channel's main timeline (`threadRootId` null)
 * or one thread, most recent first. The channel's rows are read once when
 * it opens; changes arrive through the workspace's single realtime
 * subscription (`listen`, kind 'typing'), and a 1 s tick runs only while
 * a row is held, to let rows fade past the TTL (a closed tab never says
 * it stopped).
 */
export function useTypers(
  ws: Pick<ChatWorkspace, 'sb' | 'listen' | 'userId'>,
  channelId: string,
  threadRootId: string | null
): string[] {
  const { sb, listen, userId } = ws;
  const [held, setHeld] = useState<{
    channelId: string;
    rows: readonly TypingRow[];
  }>({ channelId, rows: NONE });
  const rows = held.channelId === channelId ? held.rows : NONE;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const off = listen((e) => {
      if (e.kind !== 'typing') return;
      const at = Date.now();
      setNow(at);
      setHeld((h) => {
        const base = h.channelId === channelId ? h.rows : NONE;
        const next = applyTypingChange(base, e.change, channelId, at);
        return next === h.rows ? h : { channelId, rows: next };
      });
    });
    typingIn(sb, channelId)
      .then((read) => {
        if (!alive) return;
        setNow(Date.now());
        setHeld((h) => {
          const base = h.channelId === channelId ? h.rows : NONE;
          return { channelId, rows: mergeTypingRead(base, read, channelId) };
        });
      })
      // Best effort: live changes still arrive.
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [sb, listen, channelId]);

  const holding = rows.length > 0;
  useEffect(() => {
    if (!holding) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setHeld((h) => {
        const next = pruneTyping(h.rows, at);
        return next === h.rows ? h : { ...h, rows: next };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [holding]);

  return useMemo(
    () =>
      userId
        ? activeTypers(rows, { channelId, threadRootId, selfId: userId, now })
        : [],
    [rows, channelId, threadRootId, userId, now]
  );
}
