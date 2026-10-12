'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import type { ChannelWithMembership } from '@/lib/chat';
import { composerBlock, type ComposerBlock } from '@/lib/chat/composer';
import { cachedQuery } from '@/lib/client-cache';

import { useChatWorkspaceContext } from './chat-context';

const ENABLED_TTL_MS = 60_000;

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
  if (!channel) return null;
  return composerBlock({
    kind: channel.kind,
    archived: !!channel.archivedAt,
    member: !!channel.membership,
    bankGuest: isBankGuest,
    chatEnabled: enabled,
  });
}
