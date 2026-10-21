'use client';

import { useTranslations } from 'next-intl';

import { slaChipTone, type ChipTone } from '@/lib/cases/case-page';
import { cn } from '@/lib/utils';

const TONE: Record<ChipTone, string> = {
  ok: 'bg-success-soft text-success ring-1 ring-success/30 ring-inset',
  warn: 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset',
  bad: 'bg-destructive-soft text-destructive ring-1 ring-destructive/30 ring-inset',
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
