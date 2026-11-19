'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { createClient } from '@/lib/supabase/client';

import type { GroupTabProps } from '../group-page';
import { GroupMessageLog, type GroupChatMessage as Msg } from './message-log';

const PAGE = 50;

/** One group's chat log, live, with a composer for our number. */
export function ChatTab({ groupId, detail }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const { user, profile } = useAuth();
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

  /**
   * One send into the group, shown at once as an optimistic bubble.
   * False when nothing went out (the composer gives the text back, or
   * deletes the upload); true once WhatsApp has it, even if the row was
   * not recorded (a resend would duplicate).
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
        void load()
          .then((r) => setMessages((m) => mergeMessages(m, r.messages)))
          .catch(() => undefined);
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
      setMessages((m) => m.filter((x) => x.id !== tempId));
      toast.error(t('reasons.unknown'));
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
        {!loading && !failed && messages.length === 0 && (
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
        <GroupMessageLog messages={messages} currentUserId={user?.id ?? null} />
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
