'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import type { ChannelWithMembership } from '@/lib/chat';
import { composerBlock, type ComposerBlock } from '@/lib/chat/composer';
import { cachedQuery } from '@/lib/client-cache';

import { useChatWorkspaceContext } from './chat-context';
import { useChannelRestrictions } from './use-channel-restrictions';

const ENABLED_TTL_MS = 60_000;

/**
 * The end of the viewer's posting timeout (160) while it is in force,
 * else null. Read from chat_channel_restrictions (useChannelRestrictions,
 * which re-renders when it runs out, so the block lifts by itself). A
 * workspace owner or admin is never blocked by a timeout.
 */
export function useRestrictedUntil(
  channel: ChannelWithMembership | null
): string | null {
  const { userId } = useChatWorkspaceContext();
  const { canManageMembers: workspaceAdmin } = useAuth();
  const { active } = useChannelRestrictions(
    workspaceAdmin ? null : (channel?.id ?? null)
  );
  if (workspaceAdmin || !userId) return null;
  return active.get(userId.toLowerCase()) ?? null;
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
