'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useChannelTimeline } from '@/hooks/use-channel-timeline';
import { channelMembers, markRead } from '@/lib/chat';
import { channelDisplayName } from '@/lib/chat/view';

import { ChannelHeader } from './channel-header';
import { useChatWorkspaceContext } from './chat-context';
import { MessageTimeline } from './message-timeline';

const MARK_READ_DEBOUNCE_MS = 800;

export interface ChannelViewProps {
  channelId: string;
  /** The composer (a later job) renders here, under the timeline. */
  footer?: React.ReactNode;
  onOpenThread?: (rootId: string) => void;
  onOpenMembers?: () => void;
  onOpenPins?: () => void;
}

export function ChannelView({
  channelId,
  footer,
  onOpenThread,
  onOpenMembers,
  onOpenPins,
}: ChannelViewProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const tl = useChannelTimeline(ws, channelId);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [pinCount, setPinCount] = useState<number | null>(null);
  const { sb, listen, refreshUnread } = ws;

  useEffect(() => {
    let off = false;
    channelMembers(sb, channelId)
      .then((m) => !off && setMemberCount(m.length))
      .catch(() => {});
    sb.from('message_pins')
      .select('message_id', { count: 'exact', head: true })
      .eq('channel_id', channelId)
      .then(({ count }) => !off && setPinCount(count ?? 0));
    const unlisten = listen((e) => {
      if (e.kind === 'pin' && e.event.channelId === channelId)
        setPinCount((n) =>
          Math.max(0, (n ?? 0) + (e.event.type === 'pin' ? 1 : -1))
        );
    });
    return () => {
      off = true;
      unlisten();
    };
  }, [sb, channelId, listen]);

  // Read up to now whenever the visible timeline changes.
  const newest = tl.messages[tl.messages.length - 1]?.id;
  useEffect(() => {
    if (tl.loading || !channel?.membership) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      markRead(sb, channelId)
        .then(refreshUnread)
        .catch(() => {});
    }, MARK_READ_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sb, channelId, newest, tl.loading, channel?.membership, refreshUnread]);

  const name = useMemo(
    () =>
      channel
        ? channelDisplayName(
            channel,
            ws.userId ?? '',
            ws.peopleById,
            t('unknownPerson')
          )
        : '',
    [channel, ws.userId, ws.peopleById, t]
  );

  if (!channel)
    return (
      <p className="text-muted-foreground p-8 text-center text-sm">
        {ws.channels === null ? '' : t('channel.notFound')}
      </p>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChannelHeader
        channel={channel}
        name={name}
        memberCount={memberCount}
        pinCount={pinCount}
        onOpenMembers={onOpenMembers}
        onOpenPins={onOpenPins}
      />
      {channel.kind === 'deal_room' ? (
        <p className="text-muted-foreground p-8 text-center text-sm">
          {t('channel.dealRoomNote')}
        </p>
      ) : (
        <>
          <MessageTimeline
            messages={tl.messages}
            cards={tl.cards}
            hasMoreOlder={tl.hasMoreOlder}
            loading={tl.loading}
            loadingOlder={tl.loadingOlder}
            onLoadOlder={tl.loadOlder}
            onToggleReaction={tl.toggle}
            onOpenThread={onOpenThread}
          />
          {footer}
        </>
      )}
    </div>
  );
}
