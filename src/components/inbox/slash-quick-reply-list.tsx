'use client';

import { Loader2, MessageSquare, SearchX, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/dashboard/empty-state';
import { quickReplyShortcut } from '@/lib/inbox/slash-quick-replies';
import { interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';
import { cn } from '@/lib/utils';
import type { QuickReply } from '@/types';

/** DOM id of the option at `index`, for the box's aria-activedescendant. */
export function slashOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * The "/" quick-reply list that opens above the composer. Presentational:
 * the composer owns the query, the highlight and the keys (Up/Down,
 * Enter/Tab, Escape); this renders the matches and takes clicks and
 * taps. A press never takes focus from the text box (pointerdown is
 * cancelled), so a phone keeps its keyboard up.
 */
export function SlashQuickReplyList({
  id,
  query,
  items,
  loading,
  highlight,
  onPick,
  onHighlight,
  className,
}: {
  id: string;
  query: string;
  items: QuickReply[];
  loading: boolean;
  highlight: number;
  onPick: (qr: QuickReply) => void;
  onHighlight: (index: number) => void;
  className?: string;
}) {
  const t = useTranslations('ComposerMenu');
  return (
    <div
      className={cn(
        'border-border bg-popover text-popover-foreground ring-foreground/10 z-20 overflow-hidden rounded-lg border shadow-md ring-1',
        className
      )}
    >
      <div className="text-muted-foreground border-border flex items-center gap-1.5 border-b px-3 py-1.5 text-xs">
        <Zap className="h-3.5 w-3.5" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('slashTitle')}</span>
        <span className="max-sm:hidden">{t('slashKeys')}</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm">
          <Loader2
            className="text-muted-foreground h-4 w-4 animate-spin"
            aria-hidden
          />
          <span className="text-muted-foreground">{t('slashLoading')}</span>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={
            query.trim()
              ? t('slashNoMatch', { query: query.trim() })
              : t('slashNone')
          }
          className="m-2 min-h-0 py-3"
        />
      ) : (
        <ul
          id={id}
          role="listbox"
          aria-label={t('slashTitle')}
          className="max-h-64 overflow-y-auto p-1"
        >
          {items.map((qr, index) => {
            const active = index === highlight;
            const preview =
              qr.kind === 'interactive' && qr.interactive_payload
                ? interactivePayloadPreviewText(qr.interactive_payload)
                : (qr.content_text ?? '');
            return (
              <li
                key={qr.id}
                id={slashOptionId(id, index)}
                role="option"
                aria-selected={active}
                onPointerDown={(e) => e.preventDefault()}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onPick(qr)}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-2',
                  active && 'bg-accent text-accent-foreground'
                )}
              >
                {qr.kind === 'interactive' ? (
                  <Zap
                    className="text-primary mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden
                  />
                ) : (
                  <MessageSquare
                    className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium">
                      {qr.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 truncate text-xs max-sm:hidden">
                      /{quickReplyShortcut(qr)}
                    </span>
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {preview}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
