'use client';

import { useEffect, useState } from 'react';

import {
  applyMemberEvent,
  channelMembers,
  type ChannelMember,
} from '@/lib/chat';
import type { ChatWorkspace } from '@/hooks/use-chat-workspace';

/**
 * One channel's members with their read marks, kept live from the
 * workspace's single realtime subscription (`listen`, kind 'member')
 * rather than a second one. Null until the first load.
 */
export function useChannelMembers(
  ws: Pick<ChatWorkspace, 'sb' | 'listen'>,
  channelId: string
): readonly ChannelMember[] | null {
  const { sb, listen } = ws;
  const [state, setState] = useState<{
    channelId: string;
    members: readonly ChannelMember[];
  } | null>(null);

  useEffect(() => {
    let off = false;
    // An event that lands before the first load is dropped: the load
    // almost always reads after it, and the next open re-reads anyway.
    const unlisten = listen((e) => {
      if (e.kind !== 'member') return;
      setState((s) => {
        if (!s || s.channelId !== channelId) return s;
        const members = applyMemberEvent(s.members, channelId, e.event);
        return members === s.members ? s : { channelId, members };
      });
    });
    channelMembers(sb, channelId)
      .then((members) => !off && setState({ channelId, members }))
      .catch(() => {});
    return () => {
      off = true;
      unlisten();
    };
  }, [sb, listen, channelId]);

  return state?.channelId === channelId ? state.members : null;
}
