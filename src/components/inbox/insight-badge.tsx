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
  className,
}: {
  conversation: InsightRow;
  className?: string;
}) {
  const kind = insightBadge(conversation);
  if (!kind) return null;
  return (
    <InsightBadgeInner
      kind={kind}
      conversation={conversation}
      className={className}
    />
  );
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

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) setNow(Date.now());
      }}
    >
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
      </TooltipTrigger>
      {lines.length > 0 && (
        <TooltipContent>
          <span className="flex flex-col gap-0.5">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
