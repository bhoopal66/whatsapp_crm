'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePresence } from '@/hooks/use-presence';
import {
  usePhonePresence,
  type PhonePresence,
} from '@/hooks/use-phone-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { PERSON_PRESENCE_KEY, presenceOf } from '@/lib/person-presence';
import { presenceLabel } from '@/lib/presence';

type PresenceValue = ReturnType<typeof usePresence> & {
  phone: PhonePresence;
};

const ThreadPresenceContext = createContext<PresenceValue | null>(null);

/**
 * Owns the thread's single `usePresence()` subscription, and its share
 * of the page's phone presence (`usePhonePresence`), and hands them to
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
  const phone = usePhonePresence();
  const value = useMemo(
    () => ({ getPresence, getRow, now, phone }),
    [getPresence, getRow, now, phone]
  );
  return (
    <ThreadPresenceContext.Provider value={value}>
      {children}
    </ThreadPresenceContext.Provider>
  );
}

/**
 * A member's live presence dot, read from the enclosing scope: the
 * phone's call or chosen status over the app's (lib/person-presence.ts).
 */
export function MemberPresenceDot({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const presence = useContext(ThreadPresenceContext);
  const tp = useTranslations('Presence');
  if (!presence) return null;
  const app = presence.getPresence(userId);
  const state = presenceOf(userId, presence.phone, presence.getPresence);
  return (
    <PresenceDot
      status={state}
      label={
        state === app
          ? presenceLabel(
              app,
              presence.getRow(userId)?.last_seen_at ?? null,
              presence.now
            )
          : tp(PERSON_PRESENCE_KEY[state])
      }
      className={className}
    />
  );
}
