'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { isChannelModerator } from '@/lib/chat/moderation';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { useChannelTimeline } from '@/hooks/use-channel-timeline';
import {
  firstUnreadId,
  lastOwnTopLevelId,
  markRead,
  showsReceipts,
  unreadSince,
} from '@/lib/chat';
import { offersBroadcasts } from '@/lib/chat/composer-input';
import { channelDisplayName } from '@/lib/chat/view';

import { ChannelHeader } from './channel-header';
import { useChatWorkspaceContext } from './chat-context';
import type { RowActionContext } from './message-actions';
import { useMessageMarks } from './message-marks';
import { MessageTimeline } from './message-timeline';
import { QuoteProvider, useQuoteResolver } from './quotes';
import { ReplyTargetProvider } from './reply-target';
import { SeenBy } from './seen-by';
import { useWriteBlock } from './use-write-block';

const MARK_READ_DEBOUNCE_MS = 800;

/**
 * This visit's "New messages" baseline: the viewer's read mark as it was
 * on opening (before this visit marks it read), and the newest message
 * there once the timeline loaded, so later arrivals never add a divider.
 */
interface Visit {
  channelId: string;
  since: string | null;
  /** Undefined until the first page has loaded. */
  until?: string | null;
}

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
  const members = useChannelMembers(ws, channelId);
  const memberCount = members?.length ?? null;
  const { sb, refreshUnread, userId } = ws;
  const { canManageMembers, isBankGuest } = useAuth();
  const marks = useMessageMarks();
  const block = useWriteBlock(channel);

  // A quote's jump is local state fed to the timeline's own paging and
  // highlight, not ?message=: with ?thread= open that would focus the
  // thread root, and jumpQuery may close the thread. A ?message= jump
  // takes precedence and drops a pending quote jump.
  const [quoteFocus, setQuoteFocus] = useState<string | null>(null);
  const [urlFocus, setUrlFocus] = useState(focusMessageId ?? null);
  if ((focusMessageId ?? null) !== urlFocus) {
    setUrlFocus(focusMessageId ?? null);
    if (focusMessageId) setQuoteFocus(null);
  }
  const timelineFocusId = focusMessageId || quoteFocus;
  const jumpToQuote = useCallback(
    (id: string) => {
      // Already on its way there (the timeline keys its jump by id).
      if (id === focusMessageId) return;
      setQuoteFocus(id);
    },
    [focusMessageId]
  );
  const onTimelineFocusDone = useCallback(
    (found: boolean) => {
      if (focusMessageId) {
        onFocusDone?.(found);
        return;
      }
      setQuoteFocus(null);
      if (!found) toast.error(t('channel.jumpFailed'));
    },
    [focusMessageId, onFocusDone, t]
  );
  const getQuote = useQuoteResolver(channelId, tl.messages);
  const quoteLookup = useMemo(
    () => ({ get: getQuote, jump: jumpToQuote }),
    [getQuote, jumpToQuote]
  );

  // Frozen per visit (derived state, set during render): captured from
  // the channel list's own membership row the moment the channel is
  // known, which is before markRead below can run.
  const [visit, setVisit] = useState<Visit | null>(null);
  if (channel && visit?.channelId !== channelId)
    setVisit({ channelId, since: unreadSince(channel.membership) });
  if (
    visit?.channelId === channelId &&
    visit.until === undefined &&
    !tl.loading
  ) {
    const last = tl.messages[tl.messages.length - 1];
    setVisit({
      channelId,
      since: last ? visit.since : null,
      until: last?.createdAt ?? null,
    });
  }
  const unreadId = useMemo(
    () =>
      visit?.channelId === channelId && visit.until !== undefined
        ? firstUnreadId(tl.messages, visit.since, userId, visit.until)
        : null,
    [visit, channelId, tl.messages, userId]
  );

  // Read up to now whenever the visible timeline changes, and again when
  // the tab comes back into view.
  const [shownTick, setShownTick] = useState(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setShownTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
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
  }, [
    sb,
    channelId,
    newest,
    shownTick,
    tl.loading,
    channel?.membership,
    refreshUnread,
  ]);

  // "Seen by" under the viewer's last own top-level message.
  const seenId = useMemo(
    () => lastOwnTopLevelId(tl.messages, userId),
    [tl.messages, userId]
  );
  const seenMessage = seenId
    ? (tl.messages.find((m) => m.id === seenId) ?? null)
    : null;

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
    channelAdmin: isChannelModerator({
      kind: channel.kind,
      role: channel.membership?.role,
      bankGuest: isBankGuest,
    }),
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
        <ReplyTargetProvider scope={channelId}>
          <QuoteProvider value={quoteLookup}>
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
              focusId={timelineFocusId}
              onFocusDone={onTimelineFocusDone}
              unreadId={unreadId}
              after={
                seenMessage &&
                members &&
                showsReceipts(channel.kind, members.length)
                  ? {
                      id: seenMessage.id,
                      node: (
                        <SeenBy
                          message={seenMessage}
                          kind={channel.kind}
                          members={members}
                          peopleById={ws.peopleById}
                        />
                      ),
                    }
                  : null
              }
            />
            {footer}
          </QuoteProvider>
        </ReplyTargetProvider>
      )}
    </div>
  );
}
