'use client';

import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { MeetingCall } from '@/hooks/use-meeting-call';

/**
 * What everyone in the room must be able to see at a glance. Recording
 * comes first and is never hidden: it is how people know they are on
 * the record, so it does not depend on any setting.
 */
export function RoomStatusChips({ call }: { call: MeetingCall }) {
  const t = useTranslations('MeetingRoom.status');
  if (!call.recording && !call.locked) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {call.recording && (
        <span
          role="status"
          title={t('recordingTitle')}
          data-room-recording
          className="bg-destructive flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold text-white"
        >
          <span className="size-2 rounded-full bg-white motion-safe:animate-pulse" />
          {t('recording')}
        </span>
      )}
      {call.locked && (
        <span
          title={t('lockedTitle')}
          data-room-locked
          className="bg-card-2 text-muted-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
        >
          <Lock className="size-3" aria-hidden />
          {t('locked')}
        </span>
      )}
    </span>
  );
}
