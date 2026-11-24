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
import { droppedChannelIds, timelineCacheKey } from '@/lib/chat/timeline-cache';
import {
  chatErrorKey,
  inboxHasAssigneeFilter,
  inboxTagCounts,
} from '@/lib/chat/view';
import { INBOX_FILTER } from '@/lib/inbox/campaign-inbox';
import { assigneeGroup, combineOrGroups } from '@/lib/inbox/pagination';
import { startCatchUp } from '@/lib/realtime/catch-up';
import { createClient } from '@/lib/supabase/client';
import { visibleInterval } from '@/lib/visible-interval';
import { sessionCache, sessionKey } from '@/lib/session-cache';
import { useSessionQuery } from '@/hooks/use-session-query';
import {
  CHAT_CHANNELS_QUESTION,
  CHAT_UNREAD_QUESTION,
  isOwnMemberEvent,
  patchOwnReadMark,
} from '@/lib/chat/channel-list-cache';
import {
  CHAT_PEOPLE_QUESTION,
  loadPeopleWithRetries,
  unknownPersonName,
} from '@/lib/chat/people-load';

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
  | { kind: 'typing'; change: TypingChange }
  /** Events were missed (sleep, a dropped connection): read again. */
  | { kind: 'resync' };

const DEBOUNCE_MS = 600;
const PEOPLE_REFRESH_MS = 60_000;
const EMPTY_PEOPLE: ChatPerson[] = [];
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
  // A failed first load shows an empty list rather than loading forever;
  // `channelsFailed` tells it from one that is empty.
  const channels: ChannelWithMembership[] | null =
    channelsQuery.data ?? (channelsError ? [] : null);
  const channelsFailed = !channelsQuery.data && !!channelsError;
  const unread: UnreadCount[] = unreadQuery.data ?? EMPTY_UNREAD;
  const loadChannels = channelsQuery.refresh;
  // A channel that leaves the list (removed, a 159 audience, a guest's
  // bank switched off) loses its cached timeline: RLS answers it with no
  // rows now, and the copy held must not show again.
  const channelList = channelsQuery.data;
  const listed = useRef<{
    key: typeof channelsKey;
    list: ChannelWithMembership[];
  } | null>(null);
  useEffect(() => {
    if (!channelList) return;
    const prev =
      listed.current?.key === channelsKey ? listed.current.list : null;
    listed.current = { key: channelsKey, list: channelList };
    for (const id of droppedChannelIds(prev, channelList)) {
      const key = timelineCacheKey(accountId, userId, id);
      if (key) sessionCache.delete(key);
    }
  }, [channelList, channelsKey, accountId, userId]);
  // Counts catch up on the next event when a refresh fails.
  const refreshUnread = unreadQuery.refresh;
  // Every name on the screen comes from this list, so it is kept in the
  // session cache too: entering /chat again shows names at once, and a
  // failed refresh leaves the last good list in place.
  const peopleKey = sessionKey(accountId, userId, CHAT_PEOPLE_QUESTION);
  const peopleQuery = useSessionQuery(peopleKey, () =>
    loadPeopleWithRetries(() => chatPeople(sb, accountId!))
  );
  const people = peopleQuery.data ?? EMPTY_PEOPLE;
  const unknownName = unknownPersonName(
    { loaded: !!peopleQuery.data, failed: !!peopleQuery.error },
    t('unknownPerson')
  );
  const refreshPeople = peopleQuery.refresh;
  useEffect(() => {
    if (!peopleKey) return;
    // Presence rides on this list; the first read is useSessionQuery's.
    return visibleInterval(refreshPeople, PEOPLE_REFRESH_MS);
  }, [peopleKey, refreshPeople]);

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
    // Nothing sent while the channel was down is replayed.
    const live = startCatchUp(() => {
      emit({ kind: 'resync' });
      void handlers.current.loadChannels();
      void handlers.current.refreshUnread();
    });
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
        // Someone else's row is in neither the list nor our unread counts.
        if (!isOwnMemberEvent(event, userId)) return;
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
      onStatus: live.onStatus,
    });
    return () => {
      live.stop();
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
    channelsFailed,
    people,
    peopleById,
    unknownName,
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
    tags: { id: string; name: string; count: number | null }[];
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
    // This question's last good figures: a failed count keeps its own.
    const good = new Map<string, number>();
    const kept = (key: string, n: number | null) => {
      if (n !== null) good.set(key, n);
      return good.get(key) ?? null;
    };
    const load = async () => {
      const [unassigned, mine, ...perTag] = await Promise.all([
        count({ unassigned: true }),
        count({ group: filtered ? assigneeGroup(userId) : null }),
        ...mains.map((tag) => count({ tagId: tag.id })),
      ]);
      if (cancelled) return;
      setCounts({
        unassigned: kept('unassigned', unassigned),
        mine: kept('mine', mine),
        tags: inboxTagCounts(
          mains,
          perTag.map((n, i) => kept(mains[i].id, n))
        ),
      });
    };
    void load();
    const stop = visibleInterval(load, 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, userId, accountRole, aiLive, mains]);

  return counts;
}
