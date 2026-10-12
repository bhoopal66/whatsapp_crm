'use client';

import { useState } from 'react';
import { useParams, usePathname } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { isSavedPath } from '@/lib/chat/saved';
import { cn } from '@/lib/utils';

import { ChatWorkspaceProvider } from './chat-context';
import { ChatSidebar } from './chat-sidebar';
import { DmPicker } from './dm-picker';
import { NewChannelDialog } from './new-channel-dialog';

/**
 * Sidebar + main pane. On a phone they are two screens: /chat shows the
 * sidebar, /chat/<id> the channel and /chat/saved the saved items (each
 * header has the back link). The New channel dialog and the DM picker
 * are mounted here, inside the workspace provider; never for a guest.
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ channelId?: string }>();
  const pathname = usePathname();
  const { isBankGuest } = useAuth();
  const [composeOpen, setComposeOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const activeChannelId = params?.channelId ?? null;
  const mainOpen = activeChannelId !== null || isSavedPath(pathname);
  return (
    <ChatWorkspaceProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <ChatSidebar
          activeChannelId={activeChannelId}
          onCompose={isBankGuest ? undefined : () => setComposeOpen(true)}
          onNewDm={isBankGuest ? undefined : () => setDmOpen(true)}
          className={cn(
            'w-full shrink-0 lg:w-[300px]',
            mainOpen && 'hidden lg:flex'
          )}
        />
        <div
          className={cn(
            'bg-background min-w-0 flex-1',
            !mainOpen && 'hidden lg:block'
          )}
        >
          {children}
        </div>
      </div>
      {!isBankGuest && (
        <>
          <NewChannelDialog open={composeOpen} onOpenChange={setComposeOpen} />
          <DmPicker open={dmOpen} onOpenChange={setDmOpen} />
        </>
      )}
    </ChatWorkspaceProvider>
  );
}
