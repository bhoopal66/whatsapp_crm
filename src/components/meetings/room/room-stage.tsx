'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { ParticipantId, TileSize } from '@/lib/meetings/room/contract';
import {
  tileSizes,
  type StageArrangement,
  type StageTile,
} from '@/lib/meetings/room-ui/stage';
import { STAGE_GAP, stageMetrics } from '@/lib/meetings/room-ui/tiles';

/**
 * Draws an arrangement into whatever box it is given: the gallery grid
 * (fitGrid), or a spotlight with a filmstrip. Measures itself and reports
 * every remote camera's TileSize so the engine pulls the right layer.
 */
export function RoomStage({
  arrangement,
  participantIds,
  selfId,
  renderTile,
  onPage,
  onTileSizes,
}: {
  arrangement: StageArrangement;
  participantIds: readonly ParticipantId[];
  selfId: ParticipantId | null;
  renderTile: (
    tile: StageTile,
    box: { width: number; height: number; compact: boolean }
  ) => React.ReactNode;
  onPage: (page: number) => void;
  onTileSizes: (sizes: Record<ParticipantId, TileSize>) => void;
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
    <div ref={ref} className="relative min-h-0 flex-1">
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
          <div className="absolute inset-x-0 bottom-1 flex items-center justify-center gap-2 text-xs text-white">
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              disabled={arrangement.page === 0}
              onClick={() => onPage(arrangement.page - 1)}
              aria-label={t('prevPage')}
            >
              <ChevronLeft />
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
              variant="secondary"
              disabled={arrangement.page >= arrangement.pageCount - 1}
              onClick={() => onPage(arrangement.page + 1)}
              aria-label={t('nextPage')}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      {size.width > 0 && arrangement.kind === 'spotlight' && (
        <div className="flex h-full flex-col" style={{ gap: STAGE_GAP }}>
          <div className="flex min-h-0" style={{ height: metrics.mainHeight }}>
            {renderTile(arrangement.main, {
              width: size.width,
              height: metrics.mainHeight,
              compact: false,
            })}
          </div>
          {metrics.stripHeight > 0 && (
            <div
              className="flex shrink-0 justify-center overflow-x-auto"
              style={{ gap: STAGE_GAP, height: metrics.stripHeight }}
            >
              {arrangement.strip.map((tile) => {
                const width = Math.round((metrics.stripHeight * 16) / 9);
                return (
                  <div
                    key={tile.key}
                    className="flex shrink-0"
                    style={{ width, height: metrics.stripHeight }}
                  >
                    {renderTile(tile, {
                      width,
                      height: metrics.stripHeight,
                      compact: true,
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
