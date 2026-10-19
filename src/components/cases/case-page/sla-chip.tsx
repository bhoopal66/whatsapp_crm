'use client';

import { useTranslations } from 'next-intl';

import { slaChipTone, type ChipTone } from '@/lib/cases/case-page';
import { cn } from '@/lib/utils';

const TONE: Record<ChipTone, string> = {
  ok: 'bg-wa-green/15 text-wa-green',
  warn: 'bg-amber-500/15 text-amber-800 [[data-mode=dark]_&]:text-amber-200',
  bad: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
};

/** On track / due soon / overdue, optionally prefixed with the timer. */
export function SlaChip({
  state,
  label,
}: {
  state: string | null;
  label?: string;
}) {
  const t = useTranslations('CasePage');
  const text =
    state && t.has(`sla.${state}`) ? t(`sla.${state}`) : t('sla.unknown');
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium whitespace-nowrap',
        TONE[slaChipTone(state)]
      )}
    >
      {label ? `${label}: ${text}` : text}
    </span>
  );
}
