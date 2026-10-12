'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
  groupByDay,
  isGroupedWithPrevious,
  type ChatMessage,
  type SharedCard,
} from '@/lib/chat';

import type { RowActionContext } from './message-actions';
import { MessageRow } from './message-row';

export interface MessageTimelineProps {
  messages: ChatMessage[];
  cards: Record<string, SharedCard>;
  hasMoreOlder: boolean;
  loading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (rootId: string) => void;
  actions?: RowActionContext;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Opens at the bottom, loads older pages at the top keeping the reading position. */
export function MessageTimeline(p: MessageTimelineProps) {
  const t = useTranslations('Chat');
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const heightBeforeOlder = useRef<number | null>(null);
  const atBottom = useRef(true);
  const groups = useMemo(() => groupByDay(p.messages, TZ), [p.messages]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (heightBeforeOlder.current !== null) {
      el.scrollTop += el.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [p.messages]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && p.hasMoreOlder && !p.loadingOlder && !p.loading) {
      heightBeforeOlder.current = el.scrollHeight;
      p.onLoadOlder();
    }
  };

  const dayLabel = (kind: string, dayKey: string) =>
    kind === 'today'
      ? t('timeline.today')
      : kind === 'yesterday'
        ? t('timeline.yesterday')
        : new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'UTC',
          }).format(new Date(`${dayKey}T12:00:00Z`));

  if (p.loading)
    return (
      <div className="flex-1 space-y-4 overflow-hidden p-4" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="bg-muted size-9 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-3 w-40 animate-pulse rounded" />
              <div className="bg-muted h-3 w-3/4 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    );

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4"
    >
      {p.loadingOlder && (
        <p className="text-muted-foreground py-2 text-center text-xs">
          {t('channel.loadingOlder')}
        </p>
      )}
      {p.messages.length === 0 && (
        <p className="text-muted-foreground px-4 py-16 text-center text-sm">
          {t('channel.empty')}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.dayKey}>
          <div
            className="flex items-center gap-3 px-4 pt-4 pb-1"
            role="separator"
          >
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs font-medium">
              {dayLabel(g.kind, g.dayKey)}
            </span>
            <span className="bg-border h-px flex-1" />
          </div>
          {g.messages.map((m, i) => (
            <MessageRow
              key={m.id}
              message={m}
              grouped={isGroupedWithPrevious(g.messages[i - 1], m)}
              card={p.cards[m.id]}
              actions={p.actions}
              onToggleReaction={p.onToggleReaction}
              onOpenThread={p.onOpenThread}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
