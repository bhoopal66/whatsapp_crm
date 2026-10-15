'use client';

import { useTranslations } from 'next-intl';

import type { MeetingDisplayStatus } from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

const TONE: Record<MeetingDisplayStatus, string> = {
  live: 'bg-emerald-100 text-emerald-800 [[data-mode=dark]_&]:bg-emerald-950 [[data-mode=dark]_&]:text-emerald-300',
  due: 'bg-amber-100 text-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200',
  scheduled: 'bg-muted text-foreground',
  lapsed: 'bg-muted text-muted-foreground',
  ended: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

export function MeetingStatusBadge({
  status,
}: {
  status: MeetingDisplayStatus;
}) {
  const t = useTranslations('Meetings.status');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[status]
      )}
    >
      {status === 'live' && (
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
      )}
      {t(status)}
    </span>
  );
}
