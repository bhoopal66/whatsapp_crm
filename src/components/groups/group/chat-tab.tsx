'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  GroupComposer,
  type GroupMediaSendPayload,
} from '@/components/groups/group-composer';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { mergeMessages, reasonKey } from '@/lib/groups/group-page';
import {
  groupMediaRowMedia,
  groupMediaRowType,
} from '@/lib/groups/outbound-media';
import { markGroupRead } from '@/lib/groups/mark-read';
import {
  arrivedUnconfirmed,
  groupSendAnswerKind,
  unconfirmedSends,
} from '@/lib/groups/unconfirmed-sends';
import { thrownSendKind } from '@/lib/inbox/failed-send';
import { createClient } from '@/lib/supabase/client';

import type { GroupTabProps } from '../group-page';
import { GroupMessageLog, type GroupChatMessage as Msg } from './message-log';
import { UnconfirmedSendFooter } from './unconfirmed-send';

const PAGE = 50;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** One group's chat log, live, with a composer for our number. */
export function ChatTab({ groupId, detail }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const tFailed = useTranslations('Inbox.failedSend');
  const { user, profile } = useAuth();
  const userId = user?.id ?? null;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const olderRef = useRef(false);

  const sendBlock = detail.blocks.send;

  const load = useCallback(
    async (before?: string) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (before) qs.set('before', before);
      const res = await fetch(
        `/api/whatsapp/groups/${groupId}/messages?${qs}`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { messages: Msg[]; hasMore: boolean };
    },
    [groupId]
  );

  useEffect(() => {
    let live = true;
    load()
      .then((r) => {
        if (!live) return;
        setMessages((m) => mergeMessages(m, r.messages));
        setHasMore(r.hasMore);
        // Opening the group reads it (migration 146): the sidebar's
        // Groups count drops it.
        void markGroupRead(groupId);
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load, groupId]);

  // Realtime: new and updated rows of this group (RLS applies per user).
  useEffect(() => {
    const supabase = createClient();
    // One mark-read per burst of arrivals, not one per message (each
    // also refetches the sidebar's count).
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(
        `group-messages:${groupId}:${Math.random().toString(36).slice(2)}`
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          const row = payload.new as Msg;
          if (row?.id) setMessages((m) => mergeMessages(m, [row]));
          // Seen as it arrives, so it does not count as unread.
          if (payload.eventType === 'INSERT' && row?.direction === 'in') {
            if (readTimer) clearTimeout(readTimer);
            readTimer = setTimeout(() => void markGroupRead(groupId), 2000);
          }
        }
      )
      .subscribe();
    return () => {
      if (readTimer) clearTimeout(readTimer);
      void supabase.removeChannel(channel);
    };
  }, [groupId]);

  // Follow new messages only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderRef.current) {
      olderRef.current = false;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    const first = messages[0]?.created_at;
    if (!first) return;
    setLoadingOlder(true);
    olderRef.current = true;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const r = await load(first);
      setMessages((m) => mergeMessages(m, r.messages));
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch {
      olderRef.current = false;
      toast.error(t('chat.loadFailed'));
    } finally {
      setLoadingOlder(false);
    }
  };

  // Sends that may be in the group: kept across tabs and groups.
  const allUnconfirmed = useSyncExternalStore(
    unconfirmedSends.subscribe,
    unconfirmedSends.get,
    unconfirmedSends.get
  );
  const unconfirmed = useMemo(
    () => allUnconfirmed.filter((u) => u.groupId === groupId),
    [allUnconfirmed, groupId]
  );
  useEffect(() => {
    if (userId) unconfirmedSends.claim(userId);
  }, [userId]);
  // One that turns up in the log is settled: its real row shows instead.
  useEffect(() => {
    unconfirmedSends.remove(
      arrivedUnconfirmed(unconfirmed, groupId, messages, userId)
    );
  }, [unconfirmed, groupId, messages, userId]);
  const shown = useMemo(
    () =>
      mergeMessages(
        messages,
        unconfirmed.map((u) => u.message as Msg)
      ),
    [messages, unconfirmed]
  );

  const unconfirmedFooter = (m: Msg) => {
    const row = unconfirmed.find((u) => u.message.id === m.id);
    if (!row) return null;
    const words = m.body?.trim();
    return (
      <UnconfirmedSendFooter
        onCopy={words ? () => void copy(words) : undefined}
        // Its upload stays: the message in the group may link to it.
        onDiscard={() => unconfirmedSends.remove([row])}
      />
    );
  };

  const copy = async (words: string) => {
    try {
      await navigator.clipboard.writeText(words);
      toast.success(tFailed('copied'));
    } catch {
      toast.error(tFailed('copyFailed'));
    }
  };

  const reread = () => {
    void load()
      .then((r) => setMessages((m) => mergeMessages(m, r.messages)))
      .catch(() => undefined);
  };

  /**
   * One send into the group, shown at once as an optimistic bubble.
   * False when nothing certainly went out (the composer gives the text
   * or the attachment back); true once WhatsApp has it, or may have it:
   * a resend could then put it in the group twice.
   */
  const post = async (
    payload: { text: string } | { media: GroupMediaSendPayload },
    shown: Pick<Msg, 'type' | 'body' | 'media'>
  ): Promise<boolean> => {
    if (sendBlock) return false;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Msg = {
      id: tempId,
      direction: 'out',
      sender_wa_id: null,
      // What the send route will record, so the bubble is named at once.
      sender_name: profile?.full_name?.trim() || null,
      sender_user_id: user?.id ?? null,
      ...shown,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    stickRef.current = true;
    setMessages((m) => mergeMessages(m, [optimistic]));
    // It may be in the group: never offered again, only looked for.
    const keepUnconfirmed = (): true => {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      unconfirmedSends.add(userId, {
        groupId,
        message: optimistic,
        knownIds: new Set(messages.map((m) => m.id)),
      });
      reread();
      return true;
    };
    const offlineBefore = isOffline();
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as {
        message?: Msg;
        code?: string;
      } | null;
      if (!res.ok) {
        if (groupSendAnswerKind(res.status, json?.code) === 'maybe') {
          toast.error(t('reasons.send_unconfirmed'));
          return keepUnconfirmed();
        }
        setMessages((m) => m.filter((x) => x.id !== tempId));
        toast.error(t(`reasons.${reasonKey(json?.code)}`));
        return false;
      }
      const sent = json?.message;
      if (!sent) {
        // WhatsApp took it but the row was not recorded (200 `message:
        // null`): it is out, so keep the bubble as sent.
        setMessages((m) =>
          m.map((x) => (x.id === tempId ? { ...x, status: 'sent' } : x))
        );
        reread();
        return true;
      }
      // The realtime echo may already have delivered the real row.
      setMessages((m) =>
        mergeMessages(
          m.filter((x) => x.id !== tempId),
          [sent]
        )
      );
      return true;
    } catch {
      // No answer. Only a device that was offline throughout is certain.
      if (thrownSendKind(offlineBefore, isOffline()) === 'maybe') {
        toast.error(t('reasons.send_unconfirmed'), {
          description: tFailed('noAnswer'),
        });
        return keepUnconfirmed();
      }
      setMessages((m) => m.filter((x) => x.id !== tempId));
      toast.error(tFailed('offline'));
      return false;
    }
  };

  const sendText = (text: string) =>
    post({ text }, { type: 'text', body: text, media: null });

  const sendMedia = (p: GroupMediaSendPayload) =>
    post(
      { media: p },
      {
        type: groupMediaRowType(p.kind),
        body: p.caption ?? null,
        media: groupMediaRowMedia({
          url: p.url,
          mimeType: p.mimeType,
          filename: p.filename,
        }),
      }
    );

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:px-6"
      >
        {loading && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('chat.loading')}
          </p>
        )}
        {failed && (
          <p className="text-destructive py-8 text-center text-sm">
            {t('chat.loadFailed')}
          </p>
        )}
        {!loading && !failed && shown.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('chat.empty')}
          </p>
        )}
        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? t('chat.loading') : t('chat.loadOlder')}
            </Button>
          </div>
        )}
        <GroupMessageLog
          messages={shown}
          currentUserId={userId}
          footer={unconfirmedFooter}
        />
      </div>

      <GroupComposer
        onSendText={sendText}
        onSendMedia={sendMedia}
        disabled={!!sendBlock}
        disabledReason={sendBlock ? t(`reasons.${sendBlock}`) : null}
        placeholder={t('chat.placeholder')}
      />
    </div>
  );
}
