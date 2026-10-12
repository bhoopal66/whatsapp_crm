'use client';

import { Suspense, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';
import { toast } from 'sonner';

import { ChannelView } from '@/components/chat/channel-view';
import { Composer } from '@/components/chat/composer';
import { MembersPanel } from '@/components/chat/members-panel';
import { MessageMarksProvider } from '@/components/chat/message-marks';
import { PinsPanel } from '@/components/chat/pins-panel';
import { ThreadPanel } from '@/components/chat/thread-panel';
import type { ChatMessage } from '@/lib/chat';
import { withParam } from '@/lib/chat/compose';
import {
  jumpQuery,
  rightColumn,
  timelineFocusId,
  withRightColumn,
  type RightColumn,
  type SidePanel,
} from '@/lib/chat/panels';

/** Wide enough for the right column beside the timeline (Tailwind lg). */
const SIDE_BY_SIDE = '(min-width: 1024px)';

/**
 * The right column (?thread=<root id> or ?panel=members|pins) and the
 * message to bring into view (?message=, how search results and
 * notifications link) live in the URL, so they survive a reload.
 */
function ChannelScreen() {
  const t = useTranslations('Chat.channel');
  const { channelId } = useParams<{ channelId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const right = rightColumn(params);
  const focusId = timelineFocusId(params);
  const go = useCallback(
    (q: string) => router.replace(`${pathname}${q}`, { scroll: false }),
    [router, pathname]
  );
  const show = useCallback(
    (next: RightColumn) => go(withRightColumn(query, next)),
    [go, query]
  );
  const openThread = useCallback(
    (rootId: string) => show({ kind: 'thread', rootId }),
    [show]
  );
  const toggle = (kind: SidePanel) =>
    show(right?.kind === kind ? null : { kind });
  // A phone's sheet covers the timeline, so the jump closes it there.
  const jump = (m: ChatMessage) =>
    go(jumpQuery(query, m, window.matchMedia(SIDE_BY_SIDE).matches));
  const onFocusDone = useCallback(
    (found: boolean) => {
      if (!found) toast.error(t('jumpFailed'));
      go(withParam(query, 'message', null));
    },
    [go, query, t]
  );
  const close = () => show(null);

  return (
    <MessageMarksProvider key={channelId} channelId={channelId}>
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1">
          <ChannelView
            channelId={channelId}
            footer={<Composer key={channelId} channelId={channelId} />}
            onOpenThread={openThread}
            onOpenMembers={() => toggle('members')}
            onOpenPins={() => toggle('pins')}
            focusMessageId={focusId}
            onFocusDone={onFocusDone}
          />
        </div>
        {right?.kind === 'thread' && (
          <ThreadPanel
            key={right.rootId}
            channelId={channelId}
            rootId={right.rootId}
            onClose={close}
          />
        )}
        {right?.kind === 'members' && (
          <MembersPanel
            channelId={channelId}
            onClose={close}
            onLeft={() => router.push('/chat')}
          />
        )}
        {right?.kind === 'pins' && (
          <PinsPanel channelId={channelId} onClose={close} onJump={jump} />
        )}
      </div>
    </MessageMarksProvider>
  );
}

export default function ChannelPage() {
  return (
    <Suspense fallback={null}>
      <ChannelScreen />
    </Suspense>
  );
}
