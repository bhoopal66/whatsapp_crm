'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PinOff, X } from 'lucide-react';

import {
  mentionSegments,
  pinsFor,
  type ChatMessage,
  type Pin,
} from '@/lib/chat';
import { avatarTint, boldSegments, initialOf } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { useMessageMarks } from './message-marks';
import { useWriteBlock } from './use-write-block';

const CHIP =
  'rounded px-1 font-semibold text-[#0E7C5A] bg-emerald-50 [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300';

export interface PinsPanelProps {
  channelId: string;
  onClose: () => void;
  /** Bring the pinned message into view. */
  onJump: (message: ChatMessage) => void;
}

/**
 * The right column (a full-screen sheet below lg): the channel's pins,
 * newest first. A committed pin or unpin re-reads the list; the shared
 * pin marks hide an unpin at once (and bring it back if it fails).
 */
export function PinsPanel({ channelId, onClose, onJump }: PinsPanelProps) {
  const t = useTranslations('Chat');
  const locale = useLocale();
  const ws = useChatWorkspaceContext();
  const { sb, listen, fail, people, peopleById } = ws;
  const channel = ws.channels?.find((c) => c.id === channelId) ?? null;
  const canUnpin = useWriteBlock(channel) === null;
  const marks = useMessageMarks();
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let off = false;
    pinsFor(sb, channelId)
      .then((list) => !off && setPins(list))
      .catch((err) => !off && fail(err));
    return () => {
      off = true;
    };
  }, [sb, channelId, fail, version]);

  useEffect(
    () =>
      listen((e) => {
        if (e.kind === 'pin') {
          if (e.event.channelId === channelId) setVersion((v) => v + 1);
          return;
        }
        if (e.kind !== 'message') return;
        const ev = e.event;
        const id = ev.type === 'delete' ? ev.id : ev.message.id;
        setPins((list) => {
          if (!list?.some((p) => p.messageId === id)) return list;
          return ev.type === 'delete'
            ? list.filter((p) => p.messageId !== id)
            : list.map((p) =>
                p.messageId === id ? { ...p, message: ev.message } : p
              );
        });
      }),
    [listen, channelId]
  );

  const shown = (pins ?? []).filter(
    (p) => marks.pinCount === null || marks.pinned.has(p.messageId)
  );
  const when = (ts: string) => {
    const d = new Date(ts.replace(' ', 'T'));
    return Number.isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(d);
  };

  const snippet = (m: ChatMessage): React.ReactNode => {
    if (m.deletedAt)
      return <span className="italic">{t('timeline.deleted')}</span>;
    if (!m.body.trim())
      return <span className="italic">{t('pins.noText')}</span>;
    if (m.authorKind === 'system')
      return boldSegments(m.body)
        .map((s) => s.text)
        .join('');
    return mentionSegments(m.body, people).map((s, i) =>
      s.type === 'text' ? (
        s.text
      ) : (
        <span key={i} className={CHIP}>
          @{s.type === 'mention' ? (s.name ?? t('unknownPerson')) : s.kind}
        </span>
      )
    );
  };

  const row = (p: Pin) => {
    const m = p.message;
    const person = m?.authorId
      ? peopleById.get(m.authorId.toLowerCase())
      : undefined;
    const name =
      m?.authorKind === 'system'
        ? t('timeline.system')
        : (person?.fullName ?? t('unknownPerson'));
    return (
      <li key={p.messageId} className="group relative">
        {m ? (
          <button
            type="button"
            onClick={() => onJump(m)}
            aria-label={t('pins.jump', { name })}
            className="hover:bg-muted/50 flex w-full gap-3 px-4 py-3 pr-11 text-left"
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
                avatarTint(m.authorId)
              )}
            >
              {initialOf(person?.fullName)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                <span className="font-bold">{name}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {when(m.createdAt)}
                </span>
              </span>
              <span className="line-clamp-3 text-sm break-words whitespace-pre-wrap">
                {snippet(m)}
              </span>
              {m.threadRootId && (
                <span className="text-muted-foreground block text-xs">
                  {t('pins.inThread')}
                </span>
              )}
            </span>
          </button>
        ) : (
          <p className="text-muted-foreground px-4 py-3 pr-11 text-sm italic">
            {t('thread.gone')}
          </p>
        )}
        {canUnpin && (
          <button
            type="button"
            onClick={() => void marks.setPinned(p.messageId, false)}
            aria-label={t('actions.unpin')}
            title={t('actions.unpin')}
            className="hover:bg-muted text-muted-foreground absolute top-2.5 right-3 flex size-7 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <PinOff className="size-4" aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <aside
      aria-label={t('pins.title')}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold">{t('pins.title')}</h3>
          {pins && (
            <p className="text-muted-foreground text-xs">
              {t('channel.pinned', { count: shown.length })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('pins.close')}
          className="hover:bg-muted -mr-1 rounded p-1"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pins === null ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t('pins.loading')}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t('pins.empty')}
          </p>
        ) : (
          <ul className="divide-y">{shown.map(row)}</ul>
        )}
      </div>
    </aside>
  );
}
