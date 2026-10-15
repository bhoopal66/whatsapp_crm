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
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[status]
      )}
    >
      {t(status)}
    </span>
  );
}
