'use client';

import { useState } from 'react';
import { useParams, usePathname } from 'next/navigation';

import { CreateDealRoomDialog } from '@/components/deal-rooms/create-dialog';
import { DealRoomsSidebar } from '@/components/deal-rooms/rooms-sidebar';
import { useAuth } from '@/hooks/use-auth';
import { useDealRooms } from '@/hooks/use-deal-rooms';
import { hasMinRole } from '@/lib/auth/roles';
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
  const params = useParams<{ channelId?: string; roomId?: string }>();
  const pathname = usePathname();
  const {
    isBankGuest,
    accountId,
    account,
    accountRole,
    workspaces,
    activeWorkspaceId,
  } = useAuth();
  const { rooms } = useDealRooms(accountId);
  const [composeOpen, setComposeOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [dealRoomOpen, setDealRoomOpen] = useState(false);
  // Agents and up open deal rooms (deal_room_create refuses viewers).
  const onCreateDealRoom =
    !isBankGuest && !!accountRole && hasMinRole(accountRole, 'agent')
      ? () => {
          setComposeOpen(false);
          setDealRoomOpen(true);
        }
      : undefined;
  const activeChannelId = params?.channelId ?? null;
  const activeRoomId = params?.roomId ?? null;
  // /chat/rooms (the drill-in list) and /chat/rooms/<id> (a room).
  const inRooms = pathname?.startsWith('/chat/rooms') ?? false;
  const mainOpen =
    activeChannelId !== null || activeRoomId !== null || isSavedPath(pathname);
  const sidebarClass = cn(
    'w-full shrink-0 lg:w-[300px]',
    mainOpen && 'hidden lg:flex'
  );
  return (
    <ChatWorkspaceProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        {inRooms ? (
          <DealRoomsSidebar
            rooms={rooms}
            activeRoomId={activeRoomId}
            workspaceName={
              workspaces.find((w) => w.accountId === activeWorkspaceId)?.name ??
              account?.name ??
              ''
            }
            onCreateDealRoom={onCreateDealRoom}
            className={sidebarClass}
          />
        ) : (
          <ChatSidebar
            activeChannelId={activeChannelId}
            rooms={rooms}
            onCompose={isBankGuest ? undefined : () => setComposeOpen(true)}
            onNewDm={isBankGuest ? undefined : () => setDmOpen(true)}
            className={sidebarClass}
          />
        )}
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
          <NewChannelDialog
            open={composeOpen}
            onOpenChange={setComposeOpen}
            onCreateDealRoom={onCreateDealRoom}
          />
          <CreateDealRoomDialog
            open={dealRoomOpen}
            onOpenChange={setDealRoomOpen}
          />
          <DmPicker open={dmOpen} onOpenChange={setDmOpen} />
        </>
      )}
    </ChatWorkspaceProvider>
  );
}
