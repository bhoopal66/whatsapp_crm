'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, CheckCheck, Clock, AlertCircle, Send } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  groupMessagesByDay,
  mergeMessages,
  reasonKey,
  shouldSendOnKey,
  statusTick,
} from '@/lib/groups/group-page';
import type { WhatsappGroupMessageRow } from '@/lib/groups/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import type { GroupTabProps } from '../group-page';

type Msg = Pick<
  WhatsappGroupMessageRow,
  | 'id'
  | 'direction'
  | 'sender_wa_id'
  | 'sender_name'
  | 'type'
  | 'body'
  | 'status'
  | 'created_at'
> &
  Partial<WhatsappGroupMessageRow>;

const PAGE = 50;

/** One group's chat log, live, with a composer for our number. */
export function ChatTab({ groupId, detail }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const locale = useLocale();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load]);

  // Realtime: new and updated rows of this group (RLS applies per user).
  useEffect(() => {
    const supabase = createClient();
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
        }
      )
      .subscribe();
    return () => {
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

  const send = async () => {
    const body = text.trim();
    if (!body || sending || sendBlock) return;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Msg = {
      id: tempId,
      direction: 'out',
      sender_wa_id: null,
      sender_name: null,
      type: 'text',
      body,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    stickRef.current = true;
    setSending(true);
    setText('');
    setMessages((m) => mergeMessages(m, [optimistic]));
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      const json = (await res.json().catch(() => null)) as {
        message?: Msg;
        code?: string;
      } | null;
      if (!res.ok) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        setText(body);
        toast.error(t(`reasons.${reasonKey(json?.code)}`));
        return;
      }
      const sent = json?.message;
      if (!sent) {
        // WhatsApp took it but the row was not recorded (200 `message:
        // null`): the text is out, so keep the bubble as sent, never
        // restore it to the composer (a resend would duplicate).
        setMessages((m) =>
          m.map((x) => (x.id === tempId ? { ...x, status: 'sent' } : x))
        );
        void load()
          .then((r) => setMessages((m) => mergeMessages(m, r.messages)))
          .catch(() => undefined);
        return;
      }
      // The realtime echo may already have delivered the real row.
      setMessages((m) =>
        mergeMessages(
          m.filter((x) => x.id !== tempId),
          [sent]
        )
      );
    } catch {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setText(body);
      toast.error(t('reasons.unknown'));
    } finally {
      setSending(false);
    }
  };

  const dayLabel = (day: string) =>
    day
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'full',
          timeZone: 'UTC',
        }).format(new Date(`${day}T00:00:00Z`))
      : '';
  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
      new Date(iso)
    );

  return (
    <div className="bg-card flex h-[calc(100dvh-16rem)] min-h-80 flex-col overflow-hidden rounded-lg border">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 space-y-3 overflow-y-auto p-3"
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
        {groupMessagesByDay(messages).map((g) => (
          <div key={g.day || 'unknown'} className="space-y-1.5">
            <div className="flex justify-center">
              <span className="bg-muted text-muted-foreground rounded-full px-3 py-0.5 text-xs">
                {dayLabel(g.day)}
              </span>
            </div>
            {g.messages.map((m) => {
              const out = m.direction === 'out';
              const tick = statusTick(m.direction, m.status);
              return (
                <div
                  key={m.id}
                  className={cn('flex', out ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]',
                      out
                        ? 'bg-wa-bubble-out text-foreground'
                        : 'bg-wa-bubble-in text-foreground'
                    )}
                  >
                    {!out && (
                      <p className="text-primary text-xs font-medium">
                        {m.sender_name || m.sender_wa_id || t('chat.someone')}
                      </p>
                    )}
                    <p className="break-words whitespace-pre-wrap">
                      {m.body || (
                        <span className="text-muted-foreground italic">
                          {t('chat.attachment')}
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 flex items-center justify-end gap-1 text-[11px]">
                      {timeLabel(m.created_at)}
                      {tick === 'clock' && <Clock className="size-3" />}
                      {tick === 'single' && <Check className="size-3.5" />}
                      {tick === 'double' && <CheckCheck className="size-3.5" />}
                      {tick === 'read' && (
                        <CheckCheck className="text-wa-tick-read size-3.5" />
                      )}
                      {tick === 'failed' && (
                        <AlertCircle className="text-destructive size-3.5" />
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t p-2">
        {sendBlock && (
          <p className="text-muted-foreground px-1 pb-2 text-xs">
            {t(`reasons.${sendBlock}`)}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSendOnKey(e.nativeEvent)) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!!sendBlock}
            rows={1}
            maxLength={4096}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            className="max-h-32 min-h-9 resize-none"
          />
          <Button
            size="icon"
            aria-label={t('chat.send')}
            disabled={!!sendBlock || sending || !text.trim()}
            onClick={() => void send()}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
