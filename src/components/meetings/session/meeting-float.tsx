'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { formatElapsed } from '@/lib/meetings/room-ui/people';

import { useActiveCall } from './meeting-session-provider';

/** The call, while the person works on another page. A placeholder. */
export function MeetingFloat() {
  const t = useTranslations('MeetingSession.float');
  const active = useActiveCall();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!active) return null;
  const { call, meetingId } = active;
  const since = call.liveSince ? Date.parse(call.liveSince) : NaN;
  return (
    <div
      data-meeting-float
      role="region"
      aria-label={t('region')}
      className="bg-card text-card-foreground fixed right-4 bottom-4 z-40 flex w-72 flex-col gap-2 rounded-lg border p-3 shadow-lg"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">
          {call.meeting?.title}
        </span>
        {Number.isFinite(since) && (
          <span className="text-muted-foreground tabular-nums">
            {formatElapsed(now - since)}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Link
          href={`/meetings/${meetingId}/room`}
          className={buttonVariants({ size: 'sm', className: 'flex-1' })}
        >
          {t('return')}
        </Link>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void call.leave()}
        >
          {t('leave')}
        </Button>
      </div>
    </div>
  );
}
