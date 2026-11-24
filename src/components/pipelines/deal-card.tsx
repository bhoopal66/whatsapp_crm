'use client';

import type { PipelineStage, Profile } from '@/types';
import type { BoardDeal } from '@/lib/pipelines/board-deal';
import { dealOwnerProfile } from '@/lib/pipelines/owner';
import type { useDraggable } from '@dnd-kit/core';
import { Calendar, Check, X } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { dealCurrency } from '@/lib/currency-totals';
import type { LeadScore } from '@/lib/pipelines/lead-score';
import { useLocale, useTranslations } from 'next-intl';
import { LeadScoreBadge } from './lead-score-badge';

interface DealCardProps {
  deal: BoardDeal;
  stage: PipelineStage | null;
  /** Account members, to name the owner of an unassigned deal. */
  members: Profile[];
  onEdit: (deal: BoardDeal) => void;
  isOverlay?: boolean;
  /** The lead score; null/absent when off or for a closed deal. */
  score?: LeadScore | null;
  /** Makes the card its own drag handle: the button carries dnd-kit's
   *  props, because a focusable wrapper around it would be a button
   *  inside a button. Absent on a read-only board and in the overlay. */
  drag?: Pick<ReturnType<typeof useDraggable>, 'attributes' | 'listeners'> & {
    ref: (el: HTMLElement | null) => void;
  };
}

function formatDate(dateStr: string, locale: string) {
  return new Date(dateStr).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || '?').trim();
  if (!source) return '?';
  return source.charAt(0).toUpperCase();
}

export function DealCard({
  deal,
  stage,
  members,
  onEdit,
  isOverlay,
  score,
  drag,
}: DealCardProps) {
  const { defaultCurrency } = useAuth();
  const t = useTranslations('Pipelines.card');
  const locale = useLocale();
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t('noContact');
  // The owner: the assignee, else whoever created the deal.
  const owner = dealOwnerProfile(deal, members) ?? deal.assignee ?? null;
  const ownerLabel = owner?.full_name || owner?.email || null;

  return (
    <button
      ref={drag?.ref}
      {...drag?.attributes}
      {...drag?.listeners}
      type="button"
      // Space picks the card up and drops it; a browser would also click
      // the button as the key comes up, opening the deal.
      onKeyUp={(e) => {
        if (drag && e.code === 'Space') e.preventDefault();
      }}
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group border-border bg-card dark:bg-card-2 focus-visible:ring-ring relative w-full cursor-pointer rounded-xl border py-3 ps-4 pe-3 text-start shadow-sm transition-all focus-visible:ring-2 focus-visible:outline-none ${
        isOverlay
          ? 'shadow-xl'
          : 'hover:border-input hover:-translate-y-0.5 hover:shadow-md'
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute start-0 top-0 h-full w-1 rounded-s-xl"
        style={{ backgroundColor: stage?.color ?? '#94a3b8' }}
      />

      <div className="flex items-start justify-between gap-2">
        <span className="text-foreground flex-1 text-sm leading-snug font-semibold break-words">
          {deal.title}
        </span>
        {score && <LeadScoreBadge score={score} />}
        {deal.status === 'won' && (
          <span className="bg-primary/15 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
            <Check className="h-3 w-3" />
            {t('won')}
          </span>
        )}
        {deal.status === 'lost' && (
          <span className="bg-destructive-soft text-destructive inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
            <X className="h-3 w-3" />
            {t('lost')}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="bg-secondary text-secondary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {contactLabel}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-primary text-sm font-bold">
          {formatCurrency(
            deal.value,
            dealCurrency(deal.currency, defaultCurrency)
          )}
        </span>
        {deal.expected_close_date && (
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date, locale)}
          </span>
        )}
      </div>

      {ownerLabel && (
        <div className="mt-2 flex min-w-0 items-center justify-end gap-1.5">
          <span className="text-muted-foreground truncate text-xs">
            {ownerLabel}
          </span>
          <span
            aria-hidden
            className="bg-primary/15 text-primary flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initials(ownerLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
