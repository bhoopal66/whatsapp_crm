'use client';

import { useParams } from 'next/navigation';

import { cn } from '@/lib/utils';

import { ChatWorkspaceProvider } from './chat-context';
import { ChatSidebar } from './chat-sidebar';

/**
 * Sidebar + main pane. On a phone they are two screens: /chat shows the
 * sidebar, /chat/<id> the channel (its header has the back link).
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ channelId?: string }>();
  const activeChannelId = params?.channelId ?? null;
  return (
    <ChatWorkspaceProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <ChatSidebar
          activeChannelId={activeChannelId}
          className={cn(
            'w-full shrink-0 lg:w-[300px]',
            activeChannelId && 'hidden lg:flex'
          )}
        />
        <div
          className={cn(
            'bg-background min-w-0 flex-1',
            !activeChannelId && 'hidden lg:block'
          )}
        >
          {children}
        </div>
      </div>
    </ChatWorkspaceProvider>
  );
}
