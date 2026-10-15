// What the stage draws: the tile list built from the engine snapshot,
// the pixel boxes each arrangement gets, the remote speaker Speaker mode
// keeps showing while we talk, and which video picture-in-picture takes.

import type { ParticipantId } from '@/lib/meetings/room/contract';

import { fitGrid, tileAspect, type GridFit } from './grid';
import type { StageArrangement, StageTile } from './stage';

/** Gap between tiles, CSS pixels. */
export const STAGE_GAP = 8;

export interface TileParticipantRow {
  id: ParticipantId;
  tracks: readonly { kind: 'audio' | 'video' | 'screen' }[];
}

export interface BuildTilesInput {
  selfId: ParticipantId | null;
  /** Present participants; our own row may not have arrived yet. */
  participants: readonly TileParticipantRow[];
  selfSharing: boolean;
  /** Participants whose screen track we have actually received. */
  receivedScreens: ReadonlySet<ParticipantId>;
}

/**
 * One camera tile per person, ourselves first (even before our own row
 * arrives over realtime), and a screen tile right after its owner's
 * camera. A remote screen needs both the row's published track and the
 * received track, so the stage never features an empty share.
 */
export function buildStageTiles(input: BuildTilesInput): StageTile[] {
  const { selfId } = input;
  const tiles: StageTile[] = [];
  const add = (id: ParticipantId, isSelf: boolean, sharing: boolean) => {
    tiles.push({
      key: `${id}:camera`,
      participantId: id,
      isSelf,
      kind: 'camera',
    });
    if (sharing) {
      tiles.push({
        key: `${id}:screen`,
        participantId: id,
        isSelf,
        kind: 'screen',
      });
    }
  };
  if (selfId) add(selfId, true, input.selfSharing);
  for (const row of input.participants) {
    if (row.id === selfId) continue;
    add(
      row.id,
      false,
      input.receivedScreens.has(row.id) &&
        row.tracks.some((t) => t.kind === 'screen')
    );
  }
  return tiles;
}

/** The remote speaker Speaker mode falls back to while we talk. */
export function nextRemoteSpeaker(
  previous: ParticipantId | null,
  active: ParticipantId | null,
  selfId: ParticipantId | null
): ParticipantId | null {
  return active && active !== selfId ? active : previous;
}

export interface StageMetrics {
  /** Gallery fit; null in a spotlight arrangement. */
  grid: GridFit | null;
  /** Height of the spotlight's main box, 0 in the gallery. */
  mainHeight: number;
  /** Height of one filmstrip tile, 0 when there is no strip. */
  stripHeight: number;
  /** For tileSizes(). */
  heights: { gallery: number; main: number; strip: number };
}

/** Filmstrip tile height: smaller on a phone. */
export function stripTileHeight(width: number): number {
  return width <= 640 ? 72 : 112;
}

/** The pixel boxes of an arrangement drawn into a W×H stage. */
export function stageMetrics(
  arrangement: StageArrangement,
  width: number,
  height: number
): StageMetrics {
  if (arrangement.kind === 'gallery') {
    const grid = fitGrid(
      arrangement.tiles.length,
      width,
      height,
      STAGE_GAP,
      tileAspect(width, height)
    );
    return {
      grid,
      mainHeight: 0,
      stripHeight: 0,
      heights: { gallery: grid.tileHeight, main: 0, strip: 0 },
    };
  }
  const stripHeight = arrangement.strip.length ? stripTileHeight(width) : 0;
  const mainHeight = Math.max(
    0,
    Math.floor(height - (stripHeight ? stripHeight + STAGE_GAP : 0))
  );
  return {
    grid: null,
    mainHeight,
    stripHeight,
    heights: { gallery: 0, main: mainHeight, strip: stripHeight },
  };
}

/** The tiles an arrangement actually draws. */
export function visibleTiles(arrangement: StageArrangement): StageTile[] {
  return arrangement.kind === 'gallery'
    ? arrangement.tiles
    : [arrangement.main, ...arrangement.strip];
}

/**
 * The tile picture-in-picture shows: the spotlight's main tile unless
 * that is our own camera, else the visible camera of the active (or
 * last) remote speaker, else the first visible remote camera. Only a
 * visible tile has a received video: an off-page camera is not pulled.
 */
export function pipTarget(
  arrangement: StageArrangement,
  activeSpeakerId: ParticipantId | null,
  lastRemoteSpeakerId: ParticipantId | null
): StageTile | null {
  if (
    arrangement.kind === 'spotlight' &&
    !(arrangement.main.isSelf && arrangement.main.kind === 'camera')
  ) {
    return arrangement.main;
  }
  const cameras = visibleTiles(arrangement).filter(
    (t) => t.kind === 'camera' && !t.isSelf
  );
  const pick = (id: ParticipantId | null) =>
    id ? cameras.find((t) => t.participantId === id) : undefined;
  return (
    pick(activeSpeakerId) ?? pick(lastRemoteSpeakerId) ?? cameras[0] ?? null
  );
}
