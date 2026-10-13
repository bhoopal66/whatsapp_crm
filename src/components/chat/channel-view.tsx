'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useChannelTimeline } from '@/hooks/use-channel-timeline';
import { channelMembers, markRead } from '@/lib/chat';
import { offersBroadcasts } from '@/lib/chat/composer-input';
import { channelDisplayName } from '@/lib/chat/view';

import { ChannelHeader } from './channel-header';
import { useChatWorkspaceContext } from './chat-context';
import type { RowActionContext } from './message-actions';
import { useMessageMarks } from './message-marks';
import { MessageTimeline } from './message-timeline';
import { useWriteBlock } from './use-write-block';

const MARK_READ_DEBOUNCE_MS = 800;

export interface ChannelViewProps {
  channelId: string;
  /** The composer, under the timeline. */
  footer?: React.ReactNode;
  onOpenThread?: (rootId: string) => void;
  onOpenMembers?: () => void;
  onOpenPins?: () => void;
  /** ?message=: a top-level message the timeline brings into view. */
  focusMessageId?: string | null;
  onFocusDone?: (found: boolean) => void;
  /**
   * Drawn inside a deal room's Team notes tab: the room screen has the
   * header, and the deal room's own timeline is shown.
   */
  embedded?: boolean;
}

export function ChannelView({
  channelId,
  footer,
  onOpenThread,
  onOpenMembers,
  onOpenPins,
  focusMessageId,
  onFocusDone,
  embedded = false,
}: ChannelViewProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const tl = useChannelTimeline(ws, channelId);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const { sb, refreshUnread } = ws;
  const { canManageMembers } = useAuth();
  const marks = useMessageMarks();
  const block = useWriteBlock(channel);

  useEffect(() => {
    let off = false;
    channelMembers(sb, channelId)
      .then((m) => !off && setMemberCount(m.length))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [sb, channelId]);

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

  const actions: RowActionContext = {
    userId: ws.userId,
    workspaceAdmin: canManageMembers,
    canWrite: block === null,
    threads: !!onOpenThread,
    broadcasts: offersBroadcasts(channel.kind),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!embedded && (
        <ChannelHeader
          channel={channel}
          name={name}
          memberCount={memberCount}
          pinCount={marks.pinCount}
          onOpenMembers={onOpenMembers}
          onOpenPins={onOpenPins}
        />
      )}
      {channel.kind === 'deal_room' && !embedded ? (
        <p className="text-muted-foreground p-8 text-center text-sm">
          {t('channel.dealRoomNote')}
        </p>
      ) : (
        <>
          <MessageTimeline
            messages={tl.messages}
            cards={tl.cards}
            callCards={tl.callCards}
            hasMoreOlder={tl.hasMoreOlder}
            loading={tl.loading}
            loadingOlder={tl.loadingOlder}
            onLoadOlder={tl.loadOlder}
            onToggleReaction={tl.toggle}
            onOpenThread={onOpenThread}
            actions={actions}
            focusId={focusMessageId}
            onFocusDone={onFocusDone}
          />
          {footer}
        </>
      )}
    </div>
  );
}
