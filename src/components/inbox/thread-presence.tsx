'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';

type PresenceValue = ReturnType<typeof usePresence>;

const ThreadPresenceContext = createContext<PresenceValue | null>(null);

/**
 * Owns the thread's single `usePresence()` subscription and hands it to
 * the dots below through context.
 *
 * The hook used to sit at the top of <MessageThread>, so every presence
 * event — and the 15s re-derive tick — re-rendered the whole thread,
 * every bubble included, to recolour one or two dots. Here, a presence
 * update re-renders only this provider: `children` is the same element
 * the thread created on its last render, so React skips it and wakes
 * just the context consumers.
 *
 * One scope per thread, never one per dot: `supabase.channel(name)`
 * returns the existing channel for a repeated name, so a second
 * concurrent `usePresence()` would share — and on unmount tear down —
 * the first one's channel.
 */
export function ThreadPresenceScope({ children }: { children: ReactNode }) {
  const { getPresence, getRow, now } = usePresence();
  const value = useMemo(
    () => ({ getPresence, getRow, now }),
    [getPresence, getRow, now]
  );
  return (
    <ThreadPresenceContext.Provider value={value}>
      {children}
    </ThreadPresenceContext.Provider>
  );
}

/** A member's live presence dot, read from the enclosing scope. */
export function MemberPresenceDot({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const presence = useContext(ThreadPresenceContext);
  if (!presence) return null;
  const status = presence.getPresence(userId);
  return (
    <PresenceDot
      status={status}
      label={presenceLabel(
        status,
        presence.getRow(userId)?.last_seen_at ?? null,
        presence.now
      )}
      className={className}
    />
  );
}
