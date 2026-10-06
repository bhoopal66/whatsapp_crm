'use client';

import { useCallback } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { Tone } from '@/lib/team-activity/glance';
import type { SenderActivity } from '@/lib/team-activity/report';
import {
  findingArgs,
  type Finding,
  type FindingLevel,
  type PersonAssessment,
  type PersonStatus,
} from '@/lib/team-activity/risk';
import { cn } from '@/lib/utils';

// Dark tones use `[[data-mode=dark]_&]:`, not `dark:`. The app sets
// `data-mode` on <html> and never a `.dark` class, so a `dark:` class
// here would never apply (see globals.css).
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-emerald-700 [[data-mode=dark]_&]:text-emerald-400',
  warn: 'text-amber-700 [[data-mode=dark]_&]:text-amber-400',
  bad: 'text-red-700 [[data-mode=dark]_&]:text-red-400',
};

export const TONE_BAR: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};

const STATUS_TONE: Record<PersonStatus, string> = {
  fine: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 [[data-mode=dark]_&]:text-emerald-400',
  watch:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 [[data-mode=dark]_&]:text-amber-400',
  act: 'border-red-500/30 bg-red-500/10 text-red-700 [[data-mode=dark]_&]:text-red-400',
};

export const LEVEL_STATUS: Record<FindingLevel, PersonStatus> = {
  act_now: 'act',
  keep_an_eye: 'watch',
};

const STATUS_ICON = {
  fine: CheckCircle2,
  watch: AlertTriangle,
  act: ShieldAlert,
} as const;

/** The traffic light, always with words: Fine / Keep an eye on / Act now. */
export function StatusBadge({
  status,
  className,
}: {
  status: PersonStatus;
  className?: string;
}) {
  const t = useTranslations('TeamActivity.status');
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_TONE[status],
        className
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {t(status)}
    </span>
  );
}

export function LevelIcon({
  level,
  className,
}: {
  level: FindingLevel;
  className?: string;
}) {
  const Icon = level === 'act_now' ? ShieldAlert : AlertTriangle;
  return (
    <Icon
      className={cn(
        'h-4 w-4 shrink-0',
        level === 'act_now'
          ? 'text-red-600 [[data-mode=dark]_&]:text-red-400'
          : 'text-amber-600 [[data-mode=dark]_&]:text-amber-400',
        className
      )}
      aria-hidden
    />
  );
}

/** A finding's headline and what to do, in the build's language. */
export function useFindingCopy() {
  const t = useTranslations('TeamActivity.findings');
  return useCallback(
    (f: Finding) => ({
      title: t(f.titleKey as never, findingArgs(f) as never),
      body: t(f.bodyKey as never, findingArgs(f) as never),
    }),
    [t]
  );
}

/** One line of advice for a person card. */
export function useAdvice() {
  const t = useTranslations('TeamActivity.advice');
  return useCallback(
    (p: PersonAssessment) => t(p.advice.key as never, p.advice.values as never),
    [t]
  );
}

/** A sender's name: the member's, or what the automatic sender is. */
export function useSenderName() {
  const t = useTranslations('TeamActivity.people');
  return useCallback(
    (s: SenderActivity): string => {
      if (s.kind === 'api') return t('automaticApi');
      if (s.kind === 'bot') return t('automaticBot');
      return s.name?.trim() || s.email || t('formerMember');
    },
    [t]
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
