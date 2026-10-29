'use client';

import { useState } from 'react';
import { Flame } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  insightBadge,
  insightSummary,
  type InsightBadgeKind,
} from '@/lib/inbox/insights';
import type { ConversationListItem } from '@/lib/inbox/conversations';
import { swatchOf, type PaletteRef } from '@/lib/insights/palette';
import { cn } from '@/lib/utils';

/**
 * The one Smart insights badge an Inbox row carries (docs/jev-insights.md):
 * Urgent › Upset › Wants a person › Ready to apply › Hot lead, from
 * `insightBadge`. Its tooltip lists what Jev last judged about the chat.
 * The list renders it only while the workspace has signals on.
 */

const TONE: Record<InsightBadgeKind, string> = {
  urgent: 'bg-destructive-soft text-destructive',
  upset: 'bg-warning-soft text-warning',
  wants_person: 'bg-info-soft text-info',
  ready: 'bg-success-soft text-success',
  hot: 'bg-success-soft text-success',
};

type InsightRow = Pick<
  ConversationListItem,
  | 'insight_intent'
  | 'insight_urgency'
  | 'insight_lead_temp'
  | 'insight_upset'
  | 'insight_wants_human'
  | 'insight_priority'
  | 'insight_at'
>;

export function InsightBadge({
  conversation,
  important = false,
  className,
}: {
  conversation: InsightRow;
  /** The row wears the Important pill: no second red "Urgent". */
  important?: boolean;
  className?: string;
}) {
  const kind = insightBadge(conversation, { important });
  if (!kind) return null;
  return (
    <InsightBadgeInner
      kind={kind}
      conversation={conversation}
      className={className}
    />
  );
}

/**
 * The tooltip's lines: what Jev last judged, with "Updated …" counted
 * from when the tooltip opened.
 */
function useInsightLines(conversation: InsightRow) {
  const t = useTranslations('InsightsUi');
  const format = useFormatter();
  // "Updated 5 minutes ago" counts from when the tooltip opened, not
  // from when the row rendered (a row can sit on screen for hours).
  const [now, setNow] = useState(() => Date.now());
  const summary = insightSummary(conversation);

  const lines: string[] = [];
  if (summary.lead)
    lines.push(
      t('list.tooltip.lead', { value: t(`bands.lead.${summary.lead}`) })
    );
  if (summary.intent)
    lines.push(
      t('list.tooltip.intent', { value: t(`intents.${summary.intent}`) })
    );
  if (summary.urgency)
    lines.push(
      t('list.tooltip.urgency', {
        value: t(`bands.urgency.${summary.urgency}`),
      })
    );
  if (summary.upset !== null)
    lines.push(
      t('list.tooltip.mood', {
        value: summary.upset ? t('bands.mood.upset') : t('list.tooltip.calm'),
      })
    );
  if (summary.wantsPerson) lines.push(t('bands.mood.wantsPerson'));
  if (summary.at) {
    const at = new Date(summary.at);
    if (!Number.isNaN(at.getTime()))
      lines.push(
        t('list.tooltip.updated', { when: format.relativeTime(at, now) })
      );
  }
  const onOpenChange = (open: boolean) => {
    if (open) setNow(Date.now());
  };
  return { lines, onOpenChange };
}

function InsightBadgeInner({
  kind,
  conversation,
  className,
}: {
  kind: InsightBadgeKind;
  conversation: InsightRow;
  className?: string;
}) {
  const t = useTranslations('InsightsUi');
  const { lines, onOpenChange } = useInsightLines(conversation);

  return (
    <Tooltip onOpenChange={onOpenChange}>
      {/* A span, not a button: the row itself is a <button>. */}
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 text-[10px] leading-4 font-semibold',
              TONE[kind],
              className
            )}
          />
        }
      >
        {(kind === 'ready' || kind === 'hot') && (
          <Flame className="h-2.5 w-2.5 shrink-0" aria-hidden />
        )}
        {t(`list.badge.${kind}`)}
        {/* The tooltip is hover-only: keyboard and screen-reader users
            get the same figures here. */}
        {lines.length > 0 && (
          <span className="sr-only">{`: ${lines.join('. ')}`}</span>
        )}
      </TooltipTrigger>
      <LinesContent lines={lines} />
    </Tooltip>
  );
}

function LinesContent({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <TooltipContent>
      <span className="flex flex-col gap-0.5">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </TooltipContent>
  );
}

/**
 * An Inbox row's coloured chips (`rowSignals(...).chips`, at most three),
 * each in its palette swatch and named as the legend names it. The group
 * carries the badge's tooltip and its screen-reader summary. On a narrow
 * row (a container query on the row's text column) each chip collapses
 * to its coloured dot, so the row never grows.
 */
export function InsightChips({
  conversation,
  chips,
  className,
}: {
  conversation: InsightRow;
  chips: readonly PaletteRef[];
  className?: string;
}) {
  const t = useTranslations('InsightsUi.legend.families');
  const { lines, onOpenChange } = useInsightLines(conversation);
  if (chips.length === 0) return null;
  const labels = chips.map((c) => t(`${c.family}.items.${c.key}.label`));
  return (
    <Tooltip onOpenChange={onOpenChange}>
      {/* A span, not a button: the row itself is a <button>. */}
      <TooltipTrigger
        render={
          <span
            className={cn('inline-flex shrink-0 items-center gap-1', className)}
          />
        }
      >
        {chips.map((c, i) => {
          const swatch = swatchOf(c);
          return (
            <span key={`${c.family}:${c.key}`} className="contents">
              <span
                aria-hidden
                className={cn(
                  'inline-flex shrink-0 items-center rounded px-1.5 text-[10px] leading-4 font-semibold @max-[14rem]:hidden',
                  swatch.chip
                )}
              >
                {labels[i]}
              </span>
              <span
                aria-hidden
                className={cn(
                  'hidden h-2 w-2 shrink-0 rounded-full @max-[14rem]:inline-block',
                  swatch.dot
                )}
              />
            </span>
          );
        })}
        <span className="sr-only">
          {labels.join(', ')}
          {lines.length > 0 ? `: ${lines.join('. ')}` : ''}
        </span>
      </TooltipTrigger>
      <LinesContent lines={lines} />
    </Tooltip>
  );
}
