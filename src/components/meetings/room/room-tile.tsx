'use client';

import { MicOff, MonitorUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

import { VideoTrack } from './video-track';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)![0] : '')
  ).toUpperCase();
}

/** One person's camera, or one screen share, with a name label. */
export function RoomTile({
  name,
  isSelf,
  kind,
  track,
  muted,
  featured = false,
}: {
  name: string;
  isSelf: boolean;
  kind: 'camera' | 'screen';
  /** null: camera off, or not received yet. */
  track: MediaStreamTrack | null;
  muted: boolean;
  featured?: boolean;
}) {
  const t = useTranslations('MeetingRoom');
  const label = isSelf ? t('tile.you', { name }) : name;
  return (
    <div
      className={cn(
        'bg-muted relative flex min-h-0 items-center justify-center overflow-hidden rounded-lg border',
        featured ? 'h-full' : 'aspect-video'
      )}
    >
      {track ? (
        <VideoTrack
          track={track}
          mirrored={isSelf && kind === 'camera'}
          fit={kind === 'screen' ? 'contain' : 'cover'}
        />
      ) : (
        <div className="bg-primary text-primary-foreground flex size-16 items-center justify-center rounded-full text-xl font-medium">
          {initials(name) || '?'}
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
        {kind === 'screen' ? (
          <MonitorUp className="size-3.5 shrink-0" aria-hidden />
        ) : muted ? (
          <MicOff className="size-3.5 shrink-0" aria-label={t('tile.muted')} />
        ) : null}
        <span className="truncate">
          {kind === 'screen' ? t('tile.screen', { name: label }) : label}
        </span>
      </div>
    </div>
  );
}
