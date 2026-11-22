'use client';

import {
  Hand,
  Loader2,
  MicOff,
  MonitorUp,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {
  ModerationAction,
  ParticipantId,
  Quality,
} from '@/lib/meetings/room/contract';
import {
  avatarColor,
  initials,
  qualityBars,
} from '@/lib/meetings/room-ui/people';
import { avatarTint, tileAvatarSize } from '@/lib/meetings/room-ui/tile-view';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';
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

function SpeakingBars() {
  return (
    <span aria-hidden className="flex h-2.5 shrink-0 items-end gap-px">
      {[0, 0.2, 0.4].map((delay) => (
        <span
          key={delay}
          className="meeting-eq-bar h-full w-0.5 rounded-full bg-emerald-400"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

/** Camera off, or no picture yet: the person, on their own soft tint. */
function TileAvatar({
  userId,
  name,
  photo,
  size,
  compact,
  loading,
  loadingLabel,
}: {
  userId: string;
  name: string;
  photo: string | null;
  size: number;
  compact: boolean;
  loading: boolean;
  loadingLabel: string;
}) {
  const key = userId || name;
  return (
    <div
      className={cn(
        'absolute inset-0 flex items-center justify-center',
        avatarTint(key),
        // A filmstrip tile is short: lift the avatar clear of the name.
        compact && 'pb-4'
      )}
    >
      <div className="relative">
        <div
          className={cn(
            'flex items-center justify-center overflow-hidden rounded-full font-medium text-white',
            avatarColor(key)
          )}
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.38),
          }}
          aria-hidden
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" className="size-full object-cover" />
          ) : (
            initials(name) || '?'
          )}
        </div>
        {loading && (
          <span className="absolute -end-1 -bottom-1 flex size-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-label={loadingLabel}
            />
          </span>
        )}
      </div>
    </div>
  );
}

export interface RoomTileProps {
  participantId: ParticipantId;
  name: string;
  userId: string;
  isSelf: boolean;
  kind: 'camera' | 'screen';
  /** null: camera off, or not received yet. */
  track: MediaStreamTrack | null;
  /** The camera is on but its track has not reached us yet. */
  videoLoading: boolean;
  muted: boolean;
  speaking: boolean;
  handRaised: boolean;
  /** Place in the raised-hands queue, from 1. */
  handRank: number | null;
  quality: Quality;
  pinned: boolean;
  onTogglePin: () => void;
  /** Host tools on someone else's camera; omitted otherwise. */
  onModerate?: (action: ModerationAction) => void;
  videoRef?: (el: HTMLVideoElement | null) => void;
  /** The tile's drawn size; the avatar scales with it. */
  box: { width: number; height: number };
  /** Filmstrip: smaller chips, and the pin alone on hover. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** One person's camera, or one screen share. */
export function RoomTile(p: RoomTileProps) {
  const t = useTranslations('MeetingRoom.tile');
  const { avatarOf } = useWorkspaceMembers();
  const root = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const label = p.isSelf ? t('you', { name: p.name }) : p.name;
  const compact = !!p.compact;
  const overlayBtn = cn(
    'text-white hover:bg-white/15 hover:text-white',
    compact && 'size-6'
  );

  // A track can arrive well before its first frame: the avatar stays up
  // until the <video> has a picture, so nobody sits on a black box.
  const { track, videoRef } = p;
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [paintedTrack, setPaintedTrack] = useState<MediaStreamTrack | null>(
    null
  );
  // Follows the prop's identity on purpose: a reused tile that now shows
  // someone else has to re-register its element under the new tile key.
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      setVideoEl(el);
      videoRef?.(el);
    },
    [videoRef]
  );
  useEffect(() => {
    if (!videoEl || !track) return;
    const painted = () => setPaintedTrack(track);
    videoEl.addEventListener('loadeddata', painted);
    if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      queueMicrotask(painted);
    return () => videoEl.removeEventListener('loadeddata', painted);
  }, [videoEl, track]);

  const showAvatar = p.kind === 'camera' && (!track || paintedTrack !== track);
  const speaking = p.speaking && !p.muted && p.kind === 'camera';

  // Double-click: this tile alone fills the screen; again to come back.
  const onDoubleClick = () => {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement === el)
      void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      ref={root}
      onDoubleClick={onDoubleClick}
      data-tile-participant={p.participantId}
      data-tile-kind={p.kind}
      data-tile-speaking={speaking ? 'true' : 'false'}
      className={cn(
        'group/tile relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl transition-shadow duration-150 ease-out motion-reduce:transition-none',
        p.kind === 'screen' ? 'bg-black' : 'bg-card',
        speaking && 'shadow-[0_0_0_3px_rgb(52_211_153/0.25)]',
        p.className
      )}
      style={p.style}
    >
      {track && (
        <VideoTrack
          track={track}
          mirrored={p.isSelf && p.kind === 'camera'}
          fit={p.kind === 'screen' ? 'contain' : 'cover'}
          videoRef={attachVideo}
        />
      )}
      {showAvatar && (
        <TileAvatar
          userId={p.userId}
          name={p.name}
          photo={p.userId ? avatarOf(p.userId) : null}
          size={tileAvatarSize(p.box)}
          compact={compact}
          loading={p.videoLoading || !!track}
          loadingLabel={t('videoLoading')}
        />
      )}

      <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/[0.06] ring-inset" />
      {/* Inside the tile, so a scrolling filmstrip cannot clip it. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 z-10 rounded-xl shadow-[inset_0_0_18px_rgb(52_211_153/0.35)] ring-3 ring-emerald-400 transition-opacity duration-150 ease-out ring-inset motion-reduce:transition-none',
          speaking ? 'opacity-100' : 'opacity-0'
        )}
      />

      {p.handRaised && p.kind === 'camera' && (
        <span
          role="img"
          className={cn(
            'absolute z-20 flex items-center gap-1 rounded-md bg-amber-400 font-semibold text-black tabular-nums shadow-sm',
            compact
              ? 'top-1 start-1 px-1 py-0.5 text-xs'
              : 'top-2 start-2 px-1.5 py-1 text-xs'
          )}
          aria-label={
            p.handRank ? t('handRank', { rank: p.handRank }) : t('handRaised')
          }
          title={t('handRaised')}
        >
          <Hand className={compact ? 'size-3' : 'size-3.5'} aria-hidden />
          {p.handRank}
        </span>
      )}

      <div
        className={cn(
          'absolute z-20 flex gap-0.5 rounded-lg bg-black/55 p-0.5 opacity-0 backdrop-blur-sm transition-opacity duration-150 ease-out group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 motion-reduce:transition-none',
          compact ? 'top-1 end-1' : 'top-2 end-2'
        )}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className={overlayBtn}
          onClick={p.onTogglePin}
          aria-label={p.pinned ? t('unpin') : t('pin')}
          title={p.pinned ? t('unpin') : t('pin')}
        >
          {p.pinned ? <PinOff /> : <Pin />}
        </Button>
        {p.onModerate && !compact && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className={overlayBtn}
                  aria-label={t('hostMenu')}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent data-mode="dark" align="end" className="w-44">
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

      <div
        className={cn(
          'absolute z-20 flex items-center gap-1.5 rounded-md bg-black/55 text-white backdrop-blur-sm',
          compact
            ? 'bottom-1 start-1 max-w-[calc(100%-0.5rem)] px-1.5 py-0.5 text-xs'
            : 'bottom-2 start-2 max-w-[calc(100%-1rem)] px-2 py-1 text-xs'
        )}
      >
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
        {speaking && <SpeakingBars />}
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
