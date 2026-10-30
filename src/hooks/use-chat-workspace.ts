'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useChatTags } from '@/hooks/use-chat-tags';
import { usePhonePresence } from '@/hooks/use-phone-presence';
import {
  chatPeople,
  listChannels,
  subscribeChat,
  unreadCounts,
  type ChannelRestriction,
  type ChannelWithMembership,
  type ChatPerson,
  type MemberEvent,
  type MessageEvent,
  type ReactionEvent,
  type UnreadCount,
  type VoicePlay,
} from '@/lib/chat';
import type { TypingChange } from '@/lib/chat/typing-flow';
import { chatErrorKey, inboxHasAssigneeFilter } from '@/lib/chat/view';
import { INBOX_FILTER } from '@/lib/inbox/campaign-inbox';
import { assigneeGroup, combineOrGroups } from '@/lib/inbox/pagination';
import { createClient } from '@/lib/supabase/client';
import { sessionCache, sessionKey } from '@/lib/session-cache';
import { useSessionQuery } from '@/hooks/use-session-query';
import {
  CHAT_CHANNELS_QUESTION,
  CHAT_UNREAD_QUESTION,
  patchOwnReadMark,
} from '@/lib/chat/channel-list-cache';

export type ChatEvent =
  | { kind: 'message'; event: MessageEvent }
  | { kind: 'reaction'; event: ReactionEvent }
  | {
      kind: 'pin';
      event: { type: 'pin' | 'unpin'; channelId: string; messageId: string };
    }
  /** A chat_channel_members row changed: read marks for receipts (156). */
  | { kind: 'member'; event: MemberEvent }
  /** A chat_voice_plays row was inserted: someone played a voice note (156). */
  | { kind: 'voicePlay'; play: VoicePlay }
  /** A chat_channel_restrictions row was set or lifted: a posting timeout (160). */
  | { kind: 'restriction'; restriction: ChannelRestriction }
  /** A chat_typing row changed: someone typing, or stopped (156). */
  | { kind: 'typing'; change: TypingChange };

const DEBOUNCE_MS = 600;
const PEOPLE_REFRESH_MS = 60_000;
const EMPTY_UNREAD: UnreadCount[] = [];

/**
 * Everything the /chat screen shares: channels, people (presence, with
 * the phone's live on top: usePhonePresence),
 * unread counts and ONE realtime subscription whose events the open
 * timeline (and later the thread / pins panels) receive via `listen`.
 */
export function useChatWorkspace() {
  const t = useTranslations('Chat');
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const sb = useMemo<SupabaseClient>(() => createClient(), []);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const listeners = useRef(new Set<(e: ChatEvent) => void>());
  const phonePresence = usePhonePresence();

  const fail = useCallback(
    (err: unknown) => toast.error(t(`errors.${chatErrorKey(err)}`)),
    [t]
  );

  // The channel list and unread counts come from the session cache
  // (lib/session-cache.ts): entering /chat again shows the last list at
  // once while a fresh one loads, and realtime keeps the entry current.
  const channelsKey = sessionKey(accountId, userId, CHAT_CHANNELS_QUESTION);
  const unreadKey = sessionKey(accountId, userId, CHAT_UNREAD_QUESTION);
  const channelsQuery = useSessionQuery(channelsKey, () =>
    // Archived ones too: the sidebar lists them apart (sidebarSections)
    // and they open read-only, so an admin can unarchive one (091).
    listChannels(sb, accountId!, userId!, { includeArchived: true })
  );
  const unreadQuery = useSessionQuery(unreadKey, () =>
    unreadCounts(sb, accountId!)
  );
  const channelsError = channelsQuery.error;
  useEffect(() => {
    if (channelsError) fail(channelsError);
  }, [channelsError, fail]);
  // A failed first load shows an empty list rather than loading forever.
  const channels: ChannelWithMembership[] | null =
    channelsQuery.data ?? (channelsError ? [] : null);
  const unread: UnreadCount[] = unreadQuery.data ?? EMPTY_UNREAD;
  const loadChannels = channelsQuery.refresh;
  // Counts catch up on the next event when a refresh fails.
  const refreshUnread = unreadQuery.refresh;
  const loadPeople = useCallback(async () => {
    if (!accountId) return;
    try {
      const list = await chatPeople(sb, accountId);
      setPeople(list);
    } catch {
      // Names fall back to "Unknown" until the next refresh.
    }
  }, [sb, accountId]);

  useEffect(() => {
    // Every setState in it lands after an await; started from a
    // callback so the effect body itself sets nothing. Channels and
    // unread load through useSessionQuery above.
    void Promise.resolve().then(() => loadPeople());
    const id = setInterval(() => void loadPeople(), PEOPLE_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadPeople]);

  // Handlers through a ref: the subscription is made once per account.
  const handlers = useRef({ loadChannels, refreshUnread, channelsKey });
  useEffect(() => {
    handlers.current = { loadChannels, refreshUnread, channelsKey };
  });
  useEffect(() => {
    if (!accountId || !userId) return;
    const timers: Record<string, ReturnType<typeof setTimeout>> = {};
    const later = (key: 'loadChannels' | 'refreshUnread') => {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => void handlers.current[key](), DEBOUNCE_MS);
    };
    const emit = (e: ChatEvent) => listeners.current.forEach((fn) => fn(e));
    const off = subscribeChat(sb, {
      accountId,
      userId,
      onMessage: (event) => {
        emit({ kind: 'message', event });
        later('refreshUnread');
      },
      onReaction: (event) => emit({ kind: 'reaction', event }),
      onPin: (event) => emit({ kind: 'pin', event }),
      onChannel: () => later('loadChannels'),
      onMember: (event) => {
        emit({ kind: 'member', event });
        // The echo of our own mark-read only moves last_read_at: patch it
        // in place rather than reload the list. While a fetch is in
        // flight its older answer would overwrite the patch, so reload.
        const key = handlers.current.channelsKey;
        const held =
          key && !sessionCache.isFetching(key)
            ? sessionCache.peek<ChannelWithMembership[]>(key)?.value
            : undefined;
        const patched = held ? patchOwnReadMark(held, event, userId) : null;
        if (!key || !patched) later('loadChannels');
        else if (patched !== held) sessionCache.update(key, () => patched);
        later('refreshUnread');
      },
      onVoicePlay: (play) => emit({ kind: 'voicePlay', play }),
      onRestriction: (restriction) =>
        emit({ kind: 'restriction', restriction }),
      onTyping: (change) => emit({ kind: 'typing', change }),
    });
    return () => {
      Object.values(timers).forEach(clearTimeout);
      off();
    };
  }, [sb, accountId, userId]);

  const listen = useCallback((fn: (e: ChatEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const peopleById = useMemo(
    () => new Map(people.map((p) => [p.userId.toLowerCase(), p])),
    [people]
  );

  return {
    sb,
    userId,
    accountId,
    channels,
    people,
    peopleById,
    phonePresence,
    unread,
    refreshUnread,
    reloadChannels: loadChannels,
    listen,
    fail,
  };
}

export type ChatWorkspace = ReturnType<typeof useChatWorkspace>;

/**
 * The WHATSAPP INBOX counts, each with the predicates of the inbox list
 * its row links to (lib/chat/view.ts `inboxRows`): listed chats, not in
 * the Campaign inbox while the AI is live. Head-only counts, re-read
 * every minute. Null until read, and for a guest (who has no inbox).
 */
export function useInboxCounts(enabled: boolean) {
  const { user, accountRole } = useAuth();
  const userId = user?.id ?? null;
  const aiLive = useAiAutoReplyLive();
  const { tags } = useChatTags();
  const mains = useMemo(() => (tags ?? []).filter((x) => !x.parent_id), [tags]);
  const [counts, setCounts] = useState<{
    unassigned: number | null;
    mine: number | null;
    tags: { id: string; name: string; count: number }[];
  }>({ unassigned: null, mine: null, tags: [] });

  useEffect(() => {
    if (!enabled || !userId || aiLive === null) return;
    const sb = createClient();
    let cancelled = false;
    const count = async (n: {
      unassigned?: boolean;
      group?: string | null;
      tagId?: string;
    }) => {
      let q = sb
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .not('last_message_at', 'is', null);
      if (n.unassigned) q = q.is('assigned_agent_id', null);
      if (n.tagId) q = q.eq('chat_tag_id', n.tagId);
      const or = combineOrGroups([aiLive ? INBOX_FILTER : null, n.group]);
      if (or) q = q.or(or);
      const { count: c, error } = await q;
      return error ? null : (c ?? 0);
    };
    const filtered = inboxHasAssigneeFilter(accountRole);
    const load = async () => {
      const [unassigned, mine, ...perTag] = await Promise.all([
        count({ unassigned: true }),
        count({ group: filtered ? assigneeGroup(userId) : null }),
        ...mains.map((tag) => count({ tagId: tag.id })),
      ]);
      if (cancelled) return;
      setCounts({
        unassigned,
        mine,
        tags: mains.map((tag, i) => ({
          id: tag.id,
          name: tag.name,
          count: perTag[i] ?? 0,
        })),
      });
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, userId, accountRole, aiLive, mains]);

  return counts;
}
