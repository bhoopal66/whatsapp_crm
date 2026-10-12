'use client';

import { Suspense, useCallback } from 'react';
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';

import { ChannelView } from '@/components/chat/channel-view';
import { Composer } from '@/components/chat/composer';
import { MessageMarksProvider } from '@/components/chat/message-marks';
import { ThreadPanel } from '@/components/chat/thread-panel';
import { isUuid } from '@/lib/chat';
import { withParam } from '@/lib/chat/compose';

/** The open thread lives in ?thread=<root id>, so it survives a reload. */
function ChannelScreen() {
  const { channelId } = useParams<{ channelId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = params.get('thread');
  const thread = isUuid(raw) ? raw : null;
  const query = params.toString();
  const setThread = useCallback(
    (id: string | null) =>
      router.replace(`${pathname}${withParam(query, 'thread', id)}`, {
        scroll: false,
      }),
    [router, pathname, query]
  );
  return (
    <MessageMarksProvider key={channelId} channelId={channelId}>
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1">
          <ChannelView
            channelId={channelId}
            footer={<Composer key={channelId} channelId={channelId} />}
            onOpenThread={setThread}
          />
        </div>
        {thread && (
          <ThreadPanel
            key={thread}
            channelId={channelId}
            rootId={thread}
            onClose={() => setThread(null)}
          />
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
