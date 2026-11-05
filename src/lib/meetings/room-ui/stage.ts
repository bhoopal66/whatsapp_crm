// Which tile is large: the stage arrangement for Auto (gallery),
// Speaker and screen-share modes, and the TileSize each participant's
// camera is drawn at (setTileSizes → simulcast layer).

import type { ParticipantId, TileSize } from '@/lib/meetings/room/contract';

import { paginate } from './grid';

/** Gallery, Speaker (main + filmstrip), Focus (main only). */
export type LayoutMode = 'auto' | 'speaker' | 'focus';

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
  /** Leave our camera out, unless it is alone or we are sharing. */
  hideSelf?: boolean;
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
    }
  | {
      /** The other person fills the stage; our camera floats in a corner. */
      kind: 'duo';
      main: StageTile;
      self: StageTile;
    };

export function arrangeStage(input: StageInput): StageArrangement {
  const tiles = withoutHiddenSelf(input.tiles, input.hideSelf);
  const spotlight = (
    main: StageTile,
    reason: 'pinned' | 'screen' | 'speaker'
  ): StageArrangement => ({
    kind: 'spotlight',
    reason,
    main,
    // Focus draws the main tile and nobody else.
    strip:
      input.mode === 'focus' ? [] : tiles.filter((t) => t.key !== main.key),
  });
  const pinned = input.pinnedKey
    ? tiles.find((t) => t.key === input.pinnedKey)
    : undefined;
  if (pinned) return spotlight(pinned, 'pinned');
  // Our own screen, blown up, shows us nothing new: it is the main tile
  // only when nobody else is here.
  const cameras = tiles.filter((t) => t.kind === 'camera');
  const remote = cameras.filter((t) => !t.isSelf);
  const ownScreen = tiles.find((t) => t.kind === 'screen' && t.isSelf);
  const screen =
    tiles.find((t) => t.kind === 'screen' && !t.isSelf) ??
    (remote.length ? undefined : ownScreen);
  if (screen) return spotlight(screen, 'screen');
  if ((input.mode !== 'auto' || ownScreen) && cameras.length >= 2) {
    const pick = (id: ParticipantId | null) =>
      id ? remote.find((t) => t.participantId === id) : undefined;
    const main =
      pick(input.activeSpeakerId) ??
      pick(input.lastRemoteSpeakerId) ??
      remote[0];
    if (main) return spotlight(main, 'speaker');
  }
  const self = tiles.find((t) => t.isSelf);
  if (tiles.length === 2 && remote.length === 1 && self) {
    return { kind: 'duo', main: remote[0], self };
  }
  const page = paginate(tiles, input.page, input.perPage);
  return {
    kind: 'gallery',
    tiles: page.items,
    page: page.page,
    pageCount: page.pageCount,
  };
}

/** hideSelf: our camera stays when it is alone or while we are sharing. */
function withoutHiddenSelf(
  tiles: readonly StageTile[],
  hideSelf: boolean | undefined
): readonly StageTile[] {
  if (!hideSelf || tiles.length < 2) return tiles;
  if (tiles.some((t) => t.isSelf && t.kind === 'screen')) return tiles;
  return tiles.filter((t) => !(t.isSelf && t.kind === 'camera'));
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
  } else if (arrangement.kind === 'duo') {
    put(arrangement.main, heights.main);
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
