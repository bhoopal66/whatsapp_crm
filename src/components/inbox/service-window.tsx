'use client';

// Meta's 24-hour service window in the chat screen (Cloud API numbers
// only; `MessageThread` decides when these render). The banner sits
// above the composer once the window has closed and offers the template
// picker; the countdown sits in the header while under 2 hours are left.
// The state itself is `lib/inbox/service-window.ts`.

import { Clock, LayoutTemplate } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { describeAgo } from '@/lib/inbox/service-window';

/** Why free text is blocked; the banner and the composer's toast. */
export function serviceWindowClosedText(
  t: ReturnType<typeof useTranslations<'ServiceWindow'>>,
  agoMs: number | null
): string {
  if (agoMs === null) return t('closedNever');
  const ago = describeAgo(agoMs);
  return ago.unit === 'days'
    ? t('closedDays', { count: ago.count })
    : t('closedHours', { count: ago.count });
}

export function ServiceWindowBanner({
  agoMs,
  onOpenTemplates,
}: {
  /** Since the customer last wrote; null when they never have. */
  agoMs: number | null;
  onOpenTemplates: () => void;
}) {
  const t = useTranslations('ServiceWindow');
  const text = serviceWindowClosedText(t, agoMs);
  return (
    <div
      role="status"
      className="bg-warning-soft border-warning/40 flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 sm:px-4"
    >
      <span className="text-wa-text flex min-w-0 flex-1 items-start gap-2 text-sm">
        <Clock className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0">{text}</span>
      </span>
      <Button size="sm" variant="outline" onClick={onOpenTemplates}>
        <LayoutTemplate className="h-4 w-4" aria-hidden />
        {t('sendTemplate')}
      </Button>
    </div>
  );
}

export function ServiceWindowCountdown({
  hours,
  minutes,
}: {
  hours: number;
  minutes: number;
}) {
  const t = useTranslations('ServiceWindow');
  const time =
    hours > 0
      ? t('timeHoursMinutes', { hours, minutes })
      : t('timeMinutes', { minutes });
  const full = t('countdown', { time });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={full}
            className="bg-warning-soft text-wa-text inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap"
          />
        }
      >
        <Clock className="text-warning h-3.5 w-3.5 shrink-0" aria-hidden />
        {/* The time alone in a narrow thread; the sentence when wide. */}
        <span className="@lg/thread:hidden">{time}</span>
        <span className="hidden @lg/thread:inline">{full}</span>
      </TooltipTrigger>
      <TooltipContent>{t('tooltip')}</TooltipContent>
    </Tooltip>
  );
}
