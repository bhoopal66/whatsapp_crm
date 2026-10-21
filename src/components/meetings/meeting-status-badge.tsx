'use client';

import { useTranslations } from 'next-intl';

import type { MeetingDisplayStatus } from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

const TONE: Record<MeetingDisplayStatus, string> = {
  live: 'bg-success-soft text-success',
  due: 'bg-warning-soft text-warning',
  scheduled: 'bg-info-soft text-info',
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
          <span className="bg-success absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
          <span className="bg-success relative inline-flex size-2 rounded-full" />
        </span>
      )}
      {t(status)}
    </span>
  );
}
