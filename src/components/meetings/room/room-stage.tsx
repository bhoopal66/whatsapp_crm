'use client';

import {
  ChevronLeft,
  ChevronRight,
  Copy,
  MonitorUp,
  UserPlus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { ParticipantId, TileSize } from '@/lib/meetings/room/contract';
import {
  emptyRoomAction,
  tileSizes,
  type StageArrangement,
  type StageTile,
} from '@/lib/meetings/room-ui/stage';
import { meetingLink } from '@/lib/meetings/room-ui/tile-view';
import { STAGE_GAP, stageMetrics } from '@/lib/meetings/room-ui/tiles';
import { cn } from '@/lib/utils';

const GLASS = 'bg-black/55 text-white ring-1 ring-white/10 backdrop-blur-md';

/**
 * Alone in the room: how to bring someone in, if we can
 * (`emptyRoomAction`).
 */
function EmptyRoomCard({
  meetingId,
  openToWorkspace,
  isOrganiser,
  onInvite,
}: {
  meetingId: string;
  openToWorkspace: boolean;
  isOrganiser: boolean;
  onInvite: () => void;
}) {
  const t = useTranslations('MeetingRoom.stage');
  const action = emptyRoomAction({ openToWorkspace, isOrganiser });
  const link =
    typeof window === 'undefined'
      ? ''
      : meetingLink(window.location.origin, meetingId);
  const copy = () => {
    if (!navigator.clipboard) return void toast.error(t('linkCopyFailed'));
    navigator.clipboard.writeText(link).then(
      () => toast.success(t('linkCopied')),
      () => toast.error(t('linkCopyFailed'))
    );
  };
  return (
    // The delay: on joining a busy room, the other rows land a moment
    // after we go live, and this must not flash up in between.
    <div
      data-room-empty
      className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both absolute inset-x-3 bottom-6 z-20 flex justify-center delay-1000 duration-300 ease-out motion-reduce:animate-none"
    >
      <div className={cn('w-full max-w-sm rounded-xl p-4', GLASS)}>
        <p className="text-sm font-medium">{t('aloneTitle')}</p>
        <p className="mt-0.5 text-xs text-white/70">
          {action === 'link'
            ? t('aloneBody')
            : action === 'invite'
              ? t('aloneBodyInvite')
              : t('aloneBodyWaiting')}
        </p>
        {action === 'link' && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/[0.08] py-1 pe-1 ps-3">
            <span className="min-w-0 flex-1 truncate text-xs text-white/80">
              {link}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0 text-white hover:bg-white/15 hover:text-white"
              onClick={copy}
            >
              <Copy />
              {t('copyLink')}
            </Button>
          </div>
        )}
        {action === 'invite' && (
          <Button type="button" className="mt-3 w-full" onClick={onInvite}>
            <UserPlus />
            {t('invitePeople')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** We are sharing: say so, and offer the way out. */
function SharingBanner({ onStop }: { onStop: () => void }) {
  const t = useTranslations('MeetingRoom.stage');
  return (
    <div className="pointer-events-none absolute inset-x-3 top-2 z-20 flex justify-center">
      <div
        role="status"
        className={cn(
          'pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl py-1 pe-1 ps-3 text-xs',
          GLASS
        )}
      >
        <MonitorUp className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t('sharingBanner')}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0 bg-red-500/20 text-red-200 hover:bg-red-500/30 hover:text-red-100"
          onClick={onStop}
        >
          {t('stopSharing')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Draws an arrangement into whatever box it is given: the gallery grid
 * (fitGrid), or a spotlight with a filmstrip. Measures itself and reports
 * every remote camera's TileSize so the engine pulls the right layer.
 */
export function RoomStage({
  arrangement,
  participantIds,
  selfId,
  meetingId,
  selfSharing,
  renderTile,
  onPage,
  onStopShare,
  onTileSizes,
  openToWorkspace,
  isOrganiser,
  onInvite,
}: {
  arrangement: StageArrangement;
  participantIds: readonly ParticipantId[];
  selfId: ParticipantId | null;
  meetingId: string;
  /** We are sharing our screen. */
  selfSharing: boolean;
  renderTile: (
    tile: StageTile,
    box: { width: number; height: number; compact: boolean }
  ) => React.ReactNode;
  onPage: (page: number) => void;
  onStopShare: () => void;
  onTileSizes: (sizes: Record<ParticipantId, TileSize>) => void;
  /** A copied link lets colleagues in; otherwise they need an invite. */
  openToWorkspace: boolean;
  /** Only the organiser can invite, even an admin can't. */
  isOrganiser: boolean;
  onInvite: () => void;
}) {
  const t = useTranslations('MeetingRoom.stage');
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) =>
        s.width === Math.floor(width) && s.height === Math.floor(height)
          ? s
          : { width: Math.floor(width), height: Math.floor(height) }
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = stageMetrics(arrangement, size.width, size.height);
  const sizesKey = JSON.stringify(
    size.width > 0
      ? tileSizes(
          arrangement,
          participantIds,
          metrics.heights,
          typeof window === 'undefined' ? 1 : window.devicePixelRatio,
          selfId
        )
      : null
  );
  useEffect(() => {
    const sizes = JSON.parse(sizesKey) as Record<
      ParticipantId,
      TileSize
    > | null;
    if (sizes) onTileSizes(sizes);
  }, [sizesKey, onTileSizes]);

  return (
    <div
      ref={ref}
      data-mode="dark"
      className="relative min-h-0 min-w-0 flex-1 px-3 pb-1"
    >
      {size.width > 0 && arrangement.kind === 'gallery' && metrics.grid && (
        <div
          className="flex h-full flex-wrap content-center items-center justify-center"
          style={{ gap: STAGE_GAP }}
        >
          {arrangement.tiles.map((tile) => (
            <div
              key={tile.key}
              style={{
                width: metrics.grid!.tileWidth,
                height: metrics.grid!.tileHeight,
              }}
              className="flex"
            >
              {renderTile(tile, {
                width: metrics.grid!.tileWidth,
                height: metrics.grid!.tileHeight,
                compact: false,
              })}
            </div>
          ))}
        </div>
      )}
      {size.width > 0 &&
        arrangement.kind === 'gallery' &&
        arrangement.pageCount > 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
            <div
              className={cn(
                'pointer-events-auto flex items-center gap-1 rounded-full p-0.5 text-xs tabular-nums',
                GLASS
              )}
            >
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full text-white hover:bg-white/15 hover:text-white"
                disabled={arrangement.page === 0}
                onClick={() => onPage(arrangement.page - 1)}
                aria-label={t('prevPage')}
              >
                <ChevronLeft className="rtl:rotate-180" />
              </Button>
              <span>
                {t('page', {
                  page: arrangement.page + 1,
                  count: arrangement.pageCount,
                })}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full text-white hover:bg-white/15 hover:text-white"
                disabled={arrangement.page >= arrangement.pageCount - 1}
                onClick={() => onPage(arrangement.page + 1)}
                aria-label={t('nextPage')}
              >
                <ChevronRight className="rtl:rotate-180" />
              </Button>
            </div>
          </div>
        )}
      {size.width > 0 && arrangement.kind === 'duo' && metrics.selfBox && (
        <>
          <div className="flex h-full">
            {renderTile(arrangement.main, {
              width: size.width,
              height: metrics.mainHeight,
              compact: false,
            })}
          </div>
          <div
            className="absolute end-6 bottom-4 z-20 flex rounded-xl shadow-lg ring-1 shadow-black/40 ring-white/10"
            style={metrics.selfBox}
          >
            {renderTile(arrangement.self, {
              ...metrics.selfBox,
              compact: true,
            })}
          </div>
        </>
      )}
      {size.width > 0 && arrangement.kind === 'spotlight' && (
        <div
          className={cn(
            'flex h-full',
            metrics.stripPlacement === 'bottom' && 'flex-col'
          )}
          style={{ gap: STAGE_GAP }}
        >
          <div
            className="flex min-h-0 min-w-0"
            style={{ width: metrics.mainWidth, height: metrics.mainHeight }}
          >
            {renderTile(arrangement.main, {
              width: metrics.mainWidth,
              height: metrics.mainHeight,
              compact: false,
            })}
          </div>
          {metrics.stripHeight > 0 && (
            <div
              className={cn(
                'flex shrink-0',
                metrics.stripPlacement === 'right'
                  ? 'flex-col overflow-y-auto'
                  : 'justify-center overflow-x-auto'
              )}
              style={{
                gap: STAGE_GAP,
                ...(metrics.stripPlacement === 'right'
                  ? { width: metrics.stripWidth }
                  : { height: metrics.stripHeight }),
              }}
            >
              {arrangement.strip.map((tile) => (
                <div
                  key={tile.key}
                  className="flex shrink-0"
                  style={{
                    width: metrics.stripWidth,
                    height: metrics.stripHeight,
                  }}
                >
                  {renderTile(tile, {
                    width: metrics.stripWidth,
                    height: metrics.stripHeight,
                    compact: true,
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {size.width > 0 && selfSharing && <SharingBanner onStop={onStopShare} />}
      {size.width > 0 && participantIds.length <= 1 && !selfSharing && (
        <EmptyRoomCard
          meetingId={meetingId}
          openToWorkspace={openToWorkspace}
          isOrganiser={isOrganiser}
          onInvite={onInvite}
        />
      )}
    </div>
  );
}
