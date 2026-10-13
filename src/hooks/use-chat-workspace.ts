'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useChatTags } from '@/hooks/use-chat-tags';
import {
  chatPeople,
  listChannels,
  subscribeChat,
  unreadCounts,
  type ChannelWithMembership,
  type ChatPerson,
  type MessageEvent,
  type ReactionEvent,
  type UnreadCount,
} from '@/lib/chat';
import { chatErrorKey, inboxHasAssigneeFilter } from '@/lib/chat/view';
import { INBOX_FILTER } from '@/lib/inbox/campaign-inbox';
import { assigneeGroup, combineOrGroups } from '@/lib/inbox/pagination';
import { createClient } from '@/lib/supabase/client';

export type ChatEvent =
  | { kind: 'message'; event: MessageEvent }
  | { kind: 'reaction'; event: ReactionEvent }
  | {
      kind: 'pin';
      event: { type: 'pin' | 'unpin'; channelId: string; messageId: string };
    };

const DEBOUNCE_MS = 600;
const PEOPLE_REFRESH_MS = 60_000;

/**
 * Everything the /chat screen shares: channels, people (presence),
 * unread counts and ONE realtime subscription whose events the open
 * timeline (and later the thread / pins panels) receive via `listen`.
 */
export function useChatWorkspace() {
  const t = useTranslations('Chat');
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const sb = useMemo<SupabaseClient>(() => createClient(), []);
  const [channels, setChannels] = useState<ChannelWithMembership[] | null>(
    null
  );
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [unread, setUnread] = useState<UnreadCount[]>([]);
  const listeners = useRef(new Set<(e: ChatEvent) => void>());

  const fail = useCallback(
    (err: unknown) => toast.error(t(`errors.${chatErrorKey(err)}`)),
    [t]
  );
  const loadChannels = useCallback(async () => {
    if (!accountId || !userId) return;
    try {
      // Archived ones too: the sidebar lists them apart (sidebarSections)
      // and they open read-only, so an admin can unarchive one (091).
      const list = await listChannels(sb, accountId, userId, {
        includeArchived: true,
      });
      setChannels(list);
    } catch (err) {
      setChannels((prev) => prev ?? []);
      fail(err);
    }
  }, [sb, accountId, userId, fail]);
  const refreshUnread = useCallback(async () => {
    if (!accountId) return;
    try {
      const counts = await unreadCounts(sb, accountId);
      setUnread(counts);
    } catch {
      // Counts catch up on the next event.
    }
  }, [sb, accountId]);
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
    // Every setState in these lands after an await; started from a
    // callback so the effect body itself sets nothing.
    void Promise.resolve().then(() =>
      Promise.all([loadChannels(), loadPeople(), refreshUnread()])
    );
    const id = setInterval(() => void loadPeople(), PEOPLE_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadChannels, loadPeople, refreshUnread]);

  // Handlers through a ref: the subscription is made once per account.
  const handlers = useRef({ loadChannels, refreshUnread });
  useEffect(() => {
    handlers.current = { loadChannels, refreshUnread };
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
      onMember: () => {
        later('loadChannels');
        later('refreshUnread');
      },
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
