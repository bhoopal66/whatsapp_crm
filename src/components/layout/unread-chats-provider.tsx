'use client';

import { createContext, useCallback, useContext, useRef } from 'react';

import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useAuth } from '@/hooks/use-auth';
import {
  useUnreadChats,
  type UnreadChats,
  type UnreadRow,
} from '@/hooks/use-total-unread';
import {
  messageSoundKey,
  openChatId,
  shouldPlayMessageSound,
  soundWorthyChat,
} from '@/lib/tab-alerts/message-sound';
import {
  playMessageSound,
  readMessageSoundOn,
} from '@/components/layout/message-sound';

const EMPTY: UnreadChats = { inbox: 0, team: 0, hr: 0 };

const UnreadChatsContext = createContext<UnreadChats | null>(null);

/**
 * The tab's one unread mirror (`useUnreadChats`), shared by the sidebar
 * and the tab title, so they never disagree and only one realtime
 * channel is open. Also plays the optional new-message sound off the
 * same events, since a rise in a chat's unread count is a customer's
 * new message.
 */
export function UnreadChatsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const aiLive = useAiAutoReplyLive() === true;
  const lastPlayedAt = useRef<number | null>(null);

  const onUnreadRise = useCallback(
    (row: UnreadRow) => {
      if (!userId || typeof document === 'undefined') return;
      if (!soundWorthyChat(row, aiLive, userId)) return;
      const now = Date.now();
      const play = shouldPlayMessageSound({
        // Read on every message, so the Settings switch applies at once.
        enabled: readMessageSoundOn(messageSoundKey(userId)),
        conversationId: row.id,
        openConversationId: openChatId(
          window.location.pathname,
          window.location.search
        ),
        tabFocused:
          document.visibilityState === 'visible' && document.hasFocus(),
        now,
        lastPlayedAt: lastPlayedAt.current,
      });
      if (!play) return;
      lastPlayedAt.current = now;
      playMessageSound();
    },
    [userId, aiLive]
  );

  const counts = useUnreadChats(onUnreadRise);
  return (
    <UnreadChatsContext.Provider value={counts}>
      {children}
    </UnreadChatsContext.Provider>
  );
}

/** The shared unread counts; all zero outside the provider. */
export function useSharedUnreadChats(): UnreadChats {
  return useContext(UnreadChatsContext) ?? EMPTY;
}
