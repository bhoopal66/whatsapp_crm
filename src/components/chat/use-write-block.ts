'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import type { ChannelWithMembership } from '@/lib/chat';
import { composerBlock, type ComposerBlock } from '@/lib/chat/composer';
import { activeRestriction } from '@/lib/chat/moderation';
import { cachedQuery } from '@/lib/client-cache';

import { useChatWorkspaceContext } from './chat-context';

const ENABLED_TTL_MS = 60_000;
/** setTimeout's ceiling; a longer block re-arms when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The end of the viewer's posting timeout (160) while it is in force,
 * else null; re-renders when it runs out so the block lifts by itself.
 */
export function useRestrictedUntil(
  channel: ChannelWithMembership | null
): string | null {
  const until = channel?.membership?.postBlockedUntil ?? null;
  const [now, setNow] = useState(() => Date.now());
  const active = activeRestriction(until, now);
  useEffect(() => {
    if (!active) return;
    const ms = Date.parse(active.replace(' ', 'T')) - Date.now();
    const id = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(ms, 0) + 250, MAX_TIMER_MS)
    );
    // A block already over (judged against an older now) fires at once.
    return () => clearTimeout(id);
  }, [active]);
  return active;
}

/**
 * Why the viewer may not post in `channel` (null = may post), the gate
 * chat_assert_can_write applies. accounts.internal_chat_enabled is read
 * once a minute per account; a failed or empty read counts as ON, so
 * the server stays the one that refuses.
 */
export function useWriteBlock(
  channel: ChannelWithMembership | null
): ComposerBlock | null {
  const { sb, accountId } = useChatWorkspaceContext();
  const { isBankGuest } = useAuth();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (!accountId) return;
    let off = false;
    cachedQuery(`chat:enabled:${accountId}`, ENABLED_TTL_MS, async () => {
      const { data, error } = await sb
        .from('accounts')
        .select('internal_chat_enabled')
        .eq('id', accountId)
        .maybeSingle();
      if (error) throw error;
      return data?.internal_chat_enabled !== false;
    })
      .then((v) => !off && setEnabled(v))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [sb, accountId]);
  const restrictedUntil = useRestrictedUntil(channel);
  if (!channel) return null;
  return composerBlock({
    kind: channel.kind,
    archived: !!channel.archivedAt,
    member: !!channel.membership,
    bankGuest: isBankGuest,
    chatEnabled: enabled,
    restricted: !!restrictedUntil,
  });
}
