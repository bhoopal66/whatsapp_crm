// Which tile is large: the stage arrangement for Auto (gallery),
// Speaker and screen-share modes, and the TileSize each participant's
// camera is drawn at (setTileSizes → simulcast layer).

import type { ParticipantId, TileSize } from '@/lib/meetings/room/contract';

import { paginate } from './grid';

export type LayoutMode = 'auto' | 'speaker';

export interface StageTile {
  /** `${participantId}:camera` or `${participantId}:screen`. */
  key: string;
  participantId: ParticipantId;
  isSelf: boolean;
  kind: 'camera' | 'screen';
}

export interface StageInput {
  /** Camera tiles, self first, plus one per screen share. */
  tiles: readonly StageTile[];
  mode: LayoutMode;
  pinnedKey: string | null;
  /** The engine's active speaker (may be ourselves). */
  activeSpeakerId: ParticipantId | null;
  /** The last remote speaker, so speaking ourselves keeps the view. */
  lastRemoteSpeakerId: ParticipantId | null;
  page: number;
  perPage?: number;
}

export type StageArrangement =
  | {
      kind: 'gallery';
      tiles: StageTile[];
      page: number;
      pageCount: number;
    }
  | {
      kind: 'spotlight';
      reason: 'pinned' | 'screen' | 'speaker';
      main: StageTile;
      strip: StageTile[];
    };

export function arrangeStage(input: StageInput): StageArrangement {
  const { tiles } = input;
  const spotlight = (
    main: StageTile,
    reason: 'pinned' | 'screen' | 'speaker'
  ): StageArrangement => ({
    kind: 'spotlight',
    reason,
    main,
    strip: tiles.filter((t) => t.key !== main.key),
  });
  const pinned = input.pinnedKey
    ? tiles.find((t) => t.key === input.pinnedKey)
    : undefined;
  if (pinned) return spotlight(pinned, 'pinned');
  // Someone else's screen ahead of our own: our own, blown up, shows
  // us nothing new.
  const screen =
    tiles.find((t) => t.kind === 'screen' && !t.isSelf) ??
    tiles.find((t) => t.kind === 'screen');
  if (screen) return spotlight(screen, 'screen');
  const cameras = tiles.filter((t) => t.kind === 'camera');
  if (input.mode === 'speaker' && cameras.length >= 2) {
    const remote = cameras.filter((t) => !t.isSelf);
    const pick = (id: ParticipantId | null) =>
      id ? remote.find((t) => t.participantId === id) : undefined;
    const main =
      pick(input.activeSpeakerId) ??
      pick(input.lastRemoteSpeakerId) ??
      remote[0];
    if (main) return spotlight(main, 'speaker');
  }
  const page = paginate(tiles, input.page, input.perPage);
  return {
    kind: 'gallery',
    tiles: page.items,
    page: page.page,
    pageCount: page.pageCount,
  };
}

/** CSS height × devicePixelRatio → layer: ≥ 360 px full, ≥ 180 half. */
export function sizeForHeight(cssHeight: number, dpr = 1): TileSize {
  const px = cssHeight * (dpr > 0 ? dpr : 1);
  if (px >= 360) return 'large';
  if (px >= 180) return 'medium';
  return 'small';
}

/**
 * Every remote participant's camera size: what the arrangement draws,
 * `hidden` when their camera is on no visible tile (another gallery
 * page). Ourselves are left out: we pull nothing of our own.
 */
export function tileSizes(
  arrangement: StageArrangement,
  participantIds: readonly ParticipantId[],
  heights: { gallery: number; main: number; strip: number },
  dpr = 1,
  selfId: ParticipantId | null = null
): Record<ParticipantId, TileSize> {
  const shown = new Map<ParticipantId, TileSize>();
  const put = (tile: StageTile, height: number) => {
    if (tile.isSelf || tile.kind !== 'camera') return;
    shown.set(tile.participantId, sizeForHeight(height, dpr));
  };
  if (arrangement.kind === 'gallery') {
    for (const tile of arrangement.tiles) put(tile, heights.gallery);
  } else {
    put(arrangement.main, heights.main);
    for (const tile of arrangement.strip) put(tile, heights.strip);
  }
  const out: Record<ParticipantId, TileSize> = {};
  for (const id of participantIds) {
    if (id !== selfId) out[id] = shown.get(id) ?? 'hidden';
  }
  return out;
}
