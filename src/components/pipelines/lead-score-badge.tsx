'use client';

import { useTranslations } from 'next-intl';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { paletteFor } from '@/lib/insights/palette';
import type { LeadScore, LeadScoreBand } from '@/lib/pipelines/lead-score';
import { cn } from '@/lib/utils';

/**
 * The lead score on a deal card ("84 · Hot", docs/jev-insights.md):
 * its band's tone, a warning dot when the deal is at risk, and a tooltip
 * with the reasons in plain words. The board renders it only while the
 * workspace has Customer insights on.
 */

// The same swatches the inbox rows and the legend wear (palette.ts).
const TONE: Record<LeadScoreBand, string> = {
  hot: paletteFor('lead', 'hot').chip,
  warm: paletteFor('lead', 'warm').chip,
  cold: paletteFor('lead', 'cold').chip,
};

export function LeadScoreBadge({ score }: { score: LeadScore }) {
  const t = useTranslations('LeadScore');
  const band = t(`band.${score.band}`);
  return (
    <Tooltip>
      {/* A span, not a button: the deal card itself is a <button>. */}
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums',
              TONE[score.band]
            )}
            aria-label={t('aria', { score: score.score, band })}
          />
        }
      >
        {score.atRisk && (
          <span
            aria-hidden
            data-testid="lead-score-risk"
            className="bg-destructive h-1.5 w-1.5 shrink-0 rounded-full"
          />
        )}
        {t('badge', { score: score.score, band })}
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{t('title')}</span>
          {score.reasons.map((r) => (
            <span key={r}>{t(`reason.${r}`)}</span>
          ))}
          {score.basis === 'activity' && <span>{t('activityOnly')}</span>}
          {score.basis === 'stage' && <span>{t('stageOnly')}</span>}
          <span className="opacity-80">{t('guide')}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
