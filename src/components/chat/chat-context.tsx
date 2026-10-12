'use client';

import { createContext, useContext } from 'react';

import {
  useChatWorkspace,
  type ChatWorkspace,
} from '@/hooks/use-chat-workspace';

const Ctx = createContext<ChatWorkspace | null>(null);

/** Mounted once by the /chat layout, so the sidebar and views share it. */
export function ChatWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = useChatWorkspace();
  return <Ctx.Provider value={ws}>{children}</Ctx.Provider>;
}

export function useChatWorkspaceContext(): ChatWorkspace {
  const ws = useContext(Ctx);
  if (!ws)
    throw new Error('useChatWorkspaceContext outside ChatWorkspaceProvider');
  return ws;
}
