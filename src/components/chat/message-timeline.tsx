'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
  groupByDay,
  isGroupedWithPrevious,
  type ChatMessage,
  type SharedCallCard,
  type SharedCard,
} from '@/lib/chat';
import { focusStep } from '@/lib/chat/compose';

import type { RowActionContext } from './message-actions';
import { MessageRow } from './message-row';

export interface MessageTimelineProps {
  messages: ChatMessage[];
  cards: Record<string, SharedCard>;
  callCards: Record<string, SharedCallCard>;
  hasMoreOlder: boolean;
  loading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (rootId: string) => void;
  actions?: RowActionContext;
  /** A top-level message to bring into view, paging older as needed. */
  focusId?: string | null;
  /** The jump to `focusId` ended: scrolled to it, or gave up. */
  onFocusDone?: (found: boolean) => void;
}

const HIGHLIGHT_MS = 2000;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Opens at the bottom, loads older pages at the top keeping the reading position. */
export function MessageTimeline(p: MessageTimelineProps) {
  const t = useTranslations('Chat');
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const heightBeforeOlder = useRef<number | null>(null);
  const atBottom = useRef(true);
  const groups = useMemo(() => groupByDay(p.messages, TZ), [p.messages]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focus = useRef({ id: null as string | null, pages: 0, done: false });

  // A jump: page older until the target is loaded (focusStep), then
  // scroll it into view and tint it. Older pages keep the reading
  // position, as when scrolling up by hand.
  const {
    focusId,
    onFocusDone,
    messages,
    loading,
    loadingOlder,
    hasMoreOlder,
    onLoadOlder,
  } = p;
  useEffect(() => {
    if (!focusId) {
      focus.current = { id: null, pages: 0, done: false };
      return;
    }
    if (focus.current.id !== focusId)
      focus.current = { id: focusId, pages: 0, done: false };
    const f = focus.current;
    if (f.done) return;
    const step = focusStep({
      found: messages.some((m) => m.id === focusId),
      loading,
      loadingOlder,
      hasMoreOlder,
      pagesRead: f.pages,
    });
    if (step === 'wait') return;
    if (step === 'loadOlder') {
      f.pages += 1;
      if (ref.current) heightBeforeOlder.current = ref.current.scrollHeight;
      onLoadOlder();
      return;
    }
    if (step === 'giveUp') {
      f.done = true;
      onFocusDone?.(false);
      return;
    }
    // After this commit's own scroll fix-up (the layout effect above).
    const raf = requestAnimationFrame(() => {
      f.done = true;
      ref.current
        ?.querySelector(`[data-message-id="${focusId}"]`)
        ?.scrollIntoView({ block: 'center' });
      setHighlightId(focusId);
      onFocusDone?.(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [
    focusId,
    onFocusDone,
    messages,
    loading,
    loadingOlder,
    hasMoreOlder,
    onLoadOlder,
  ]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

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
              callCard={p.callCards[m.id]}
              actions={p.actions}
              onToggleReaction={p.onToggleReaction}
              onOpenThread={p.onOpenThread}
              anchor
              highlighted={m.id === highlightId}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
