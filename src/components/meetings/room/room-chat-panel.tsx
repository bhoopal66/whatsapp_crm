'use client';

import { ArrowDown, SendHorizontal } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import {
  CHAT_MAX_CHARS,
  chatBodyToSend,
  groupChat,
  isNearBottom,
  splitLinks,
} from '@/lib/meetings/room-ui/chat';
import { chatKeyAction } from '@/lib/meetings/room-ui/keys';
import { chatCounter } from '@/lib/meetings/room-ui/panels';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';

/** In-call messages: grouped by author, links made safe, Enter sends. */
export function RoomChatPanel({
  call,
  onClose,
  autoFocus,
}: {
  call: MeetingCall;
  onClose: () => void;
  autoFocus: boolean;
}) {
  const t = useTranslations('MeetingRoom');
  const format = useFormatter();
  const { nameOf } = useWorkspaceMembers();
  const { user } = useAuth();
  const selfId = user?.id ?? null;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // Whether the reader is at the bottom; new lines scroll only then.
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const groups = groupChat(call.chat);
  const counter = chatCounter(draft.length, CHAT_MAX_CHARS);

  const scrollToEnd = () => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (atBottom) scrollToEnd();
  }, [call.chat, atBottom]);

  // A later task than the C keypress that opened the panel, so the
  // letter is not typed into the box.
  useEffect(() => {
    if (!autoFocus) return;
    const id = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [autoFocus]);

  const onScroll = () => {
    const el = list.current;
    if (el)
      setAtBottom(isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight));
  };

  const send = async () => {
    const body = chatBodyToSend(draft);
    if (!body || sending) return;
    setSending(true);
    const ok = await call.sendChat(body);
    setSending(false);
    if (ok) {
      setDraft('');
      setAtBottom(true);
    } else toast.error(t('panels.chat.sendFailed'));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const action = chatKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    });
    if (action === 'send') {
      e.preventDefault();
      void send();
    }
  };

  const nameFor = (userId: string) =>
    userId === selfId
      ? t('panels.chat.you')
      : nameOf(userId) || t('tile.unknown');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={list}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-4 pb-2"
          role="log"
          aria-live="polite"
        >
          <p className="bg-muted text-muted-foreground mb-3 rounded-md p-2 text-center text-xs">
            {t('panels.chat.hint')}
          </p>
          {groups.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {t('panels.chat.empty')}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} className="mb-3">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="truncate font-medium">
                  {nameFor(g.userId)}
                </span>
                <time
                  dateTime={g.startedAt}
                  className="text-muted-foreground shrink-0"
                >
                  {format.dateTime(new Date(g.startedAt), {
                    timeStyle: 'short',
                  })}
                </time>
              </div>
              {g.messages.map((m) => (
                <p
                  key={m.id}
                  className="mt-0.5 text-sm break-words whitespace-pre-wrap"
                >
                  {splitLinks(m.body).map((part, i) =>
                    part.type === 'link' ? (
                      <a
                        key={i}
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary break-all underline"
                      >
                        {part.text}
                      </a>
                    ) : (
                      <span key={i}>{part.text}</span>
                    )
                  )}
                </p>
              ))}
            </div>
          ))}
        </div>
        {!atBottom && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow"
            onClick={() => {
              setAtBottom(true);
              scrollToEnd();
            }}
          >
            <ArrowDown />
            {t('panels.chat.jump')}
          </Button>
        )}
      </div>
      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            readOnly={sending}
            rows={1}
            placeholder={t('panels.chat.placeholder')}
            aria-label={t('panels.chat.placeholder')}
            aria-invalid={counter.over || undefined}
            className="max-h-32 min-h-9 resize-none"
          />
          <Button
            type="button"
            size="icon"
            onClick={() => void send()}
            disabled={sending || !chatBodyToSend(draft)}
            aria-label={t('panels.chat.send')}
            title={t('panels.chat.send')}
          >
            <SendHorizontal />
          </Button>
        </div>
        {counter.show && (
          <p
            className={cn(
              'mt-1 text-right text-xs tabular-nums',
              counter.over ? 'text-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {t('panels.chat.counter', {
              count: draft.length,
              max: CHAT_MAX_CHARS,
            })}
          </p>
        )}
      </div>
    </div>
  );
}
