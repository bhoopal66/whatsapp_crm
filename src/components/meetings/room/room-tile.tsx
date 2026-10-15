'use client';

import {
  Hand,
  MicOff,
  MonitorUp,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ModerationAction, Quality } from '@/lib/meetings/room/contract';
import {
  avatarColor,
  initials,
  qualityBars,
} from '@/lib/meetings/room-ui/people';
import { cn } from '@/lib/utils';

import { ConfirmDialog } from './confirm-dialog';
import { VideoTrack } from './video-track';

const BAR_COLOR = {
  poor: 'bg-red-500',
  fair: 'bg-amber-400',
  good: 'bg-emerald-400',
  unknown: '',
};

/** Signal bars for a link; draws nothing for an unknown reading. */
export function QualityBars({ quality }: { quality: Quality }) {
  const t = useTranslations('MeetingRoom.quality');
  const bars = qualityBars(quality);
  if (!bars) return null;
  return (
    <span
      className="inline-flex items-end gap-px"
      role="img"
      aria-label={t(quality)}
      title={t(quality)}
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            'w-0.5 rounded-sm',
            i <= bars ? BAR_COLOR[quality] : 'bg-white/30'
          )}
          style={{ height: 3 + i * 3 }}
        />
      ))}
    </span>
  );
}

export interface RoomTileProps {
  name: string;
  userId: string;
  isSelf: boolean;
  kind: 'camera' | 'screen';
  /** null: camera off, or not received yet. */
  track: MediaStreamTrack | null;
  muted: boolean;
  speaking: boolean;
  handRaised: boolean;
  quality: Quality;
  pinned: boolean;
  onTogglePin: () => void;
  /** Host tools on someone else's camera; omitted otherwise. */
  onModerate?: (action: ModerationAction) => void;
  videoRef?: (el: HTMLVideoElement | null) => void;
  /** Filmstrip: a smaller avatar. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** One person's camera, or one screen share. */
export function RoomTile(p: RoomTileProps) {
  const t = useTranslations('MeetingRoom.tile');
  const box = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const label = p.isSelf ? t('you', { name: p.name }) : p.name;
  const overlayBtn = 'bg-black/60 text-white hover:bg-black/80';

  // Double-click: this tile alone fills the screen; again to come back.
  const onDoubleClick = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement === el)
      void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      ref={box}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group/tile relative flex min-h-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-800',
        p.className
      )}
      style={p.style}
    >
      {p.track ? (
        <VideoTrack
          track={p.track}
          mirrored={p.isSelf && p.kind === 'camera'}
          fit={p.kind === 'screen' ? 'contain' : 'cover'}
          videoRef={p.videoRef}
        />
      ) : (
        <div
          className={cn(
            'flex items-center justify-center rounded-full font-medium text-white',
            avatarColor(p.userId || p.name),
            p.compact ? 'size-10 text-sm' : 'size-20 text-2xl'
          )}
          aria-hidden
        >
          {initials(p.name) || '?'}
        </div>
      )}

      {p.speaking && !p.muted && p.kind === 'camera' && (
        <div className="pointer-events-none absolute inset-0 animate-pulse rounded-lg ring-3 ring-emerald-400 ring-inset" />
      )}

      {p.handRaised && p.kind === 'camera' && (
        <span
          className="absolute top-2 left-2 flex items-center rounded-md bg-amber-400 p-1 text-black"
          title={t('handRaised')}
        >
          <Hand className="size-3.5" aria-label={t('handRaised')} />
        </span>
      )}

      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within/tile:opacity-100 group-hover/tile:opacity-100">
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          className={overlayBtn}
          onClick={p.onTogglePin}
          aria-label={p.pinned ? t('unpin') : t('pin')}
          title={p.pinned ? t('unpin') : t('pin')}
        >
          {p.pinned ? <PinOff /> : <Pin />}
        </Button>
        {p.onModerate && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className={overlayBtn}
                  aria-label={t('hostMenu')}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                disabled={p.muted}
                onClick={() => p.onModerate?.('mute')}
              >
                {t('muteThem')}
              </DropdownMenuItem>
              {p.handRaised && (
                <DropdownMenuItem onClick={() => p.onModerate?.('lower_hand')}>
                  {t('lowerHand')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmRemove(true)}
              >
                {t('remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
        {p.kind === 'screen' ? (
          <MonitorUp className="size-3.5 shrink-0" aria-hidden />
        ) : p.muted ? (
          <MicOff
            className="size-3.5 shrink-0 text-red-400"
            aria-label={t('muted')}
          />
        ) : null}
        <span className="truncate">
          {p.kind === 'screen' ? t('screen', { name: label }) : label}
        </span>
        {p.kind === 'camera' &&
          (p.quality === 'poor' || p.quality === 'fair') && (
            <QualityBars quality={p.quality} />
          )}
      </div>

      {p.onModerate && (
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={t('removeTitle', { name: p.name })}
          description={t('removeBody')}
          confirmLabel={t('remove')}
          destructive
          onConfirm={() => p.onModerate?.('remove')}
        />
      )}
    </div>
  );
}
