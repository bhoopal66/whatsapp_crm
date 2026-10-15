// Simulcast: the camera is published in three layers, and each puller
// asks the SFU for the layer its tile needs (Cloudflare's `simulcast`
// track option, switched later with PUT tracks/update).

import type { ParticipantId, TileSize } from './contract';

export type Rid = 'f' | 'h' | 'q';

/** The camera's send encodings: full, half and quarter resolution. */
export const CAMERA_ENCODINGS = [
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
] as const;

/** A participant the screen has not sized yet is drawn medium. */
export const DEFAULT_TILE_SIZE: TileSize = 'medium';

/** large → f, medium → h, small → q; hidden pulls no video at all. */
export function ridForTileSize(size: TileSize): Rid | null {
  switch (size) {
    case 'large':
      return 'f';
    case 'medium':
      return 'h';
    case 'small':
      return 'q';
    default:
      return null;
  }
}

export interface SimulcastPreference {
  preferredRid: Rid;
  priorityOrdering: 'asciibetical';
  ridNotAvailable: 'asciibetical';
}

export function simulcastFor(size: TileSize): SimulcastPreference | null {
  const preferredRid = ridForTileSize(size);
  return preferredRid
    ? {
        preferredRid,
        priorityOrdering: 'asciibetical',
        ridNotAvailable: 'asciibetical',
      }
    : null;
}

export function tileSizeOf(
  sizes: Readonly<Record<ParticipantId, TileSize>>,
  participantId: ParticipantId
): TileSize {
  return sizes[participantId] ?? DEFAULT_TILE_SIZE;
}

/** Participants whose camera the screen does not draw. */
export function hiddenVideo(
  sizes: Readonly<Record<ParticipantId, TileSize>>
): Set<ParticipantId> {
  return new Set(
    Object.entries(sizes)
      .filter(([, s]) => s === 'hidden')
      .map(([id]) => id)
  );
}

export interface PulledVideo {
  trackName: string;
  participantId: ParticipantId;
  sessionId: string;
  mid: string;
  /** The layer last requested for it; null if never confirmed. */
  rid: Rid | null;
}

export interface LayerUpdate {
  location: 'remote';
  mid: string;
  sessionId: string;
  trackName: string;
  simulcast: SimulcastPreference;
}

/**
 * The tracks/update entries that bring every pulled camera to the layer
 * its tile now needs. Only cameras whose layer changes; a hidden one is
 * closed by the subscription plan instead, never updated.
 */
export function planLayerUpdates(
  sizes: Readonly<Record<ParticipantId, TileSize>>,
  pulled: readonly PulledVideo[]
): LayerUpdate[] {
  const out: LayerUpdate[] = [];
  for (const p of pulled) {
    const simulcast = simulcastFor(tileSizeOf(sizes, p.participantId));
    if (!simulcast || simulcast.preferredRid === p.rid) continue;
    out.push({
      location: 'remote',
      mid: p.mid,
      sessionId: p.sessionId,
      trackName: p.trackName,
      simulcast,
    });
  }
  return out;
}

/**
 * The layer to ask for when pulling a participant's camera, decided
 * once, before the request: the record of the pull must hold exactly
 * what was sent (`landedPull`).
 */
export function pullSimulcast(
  sizes: Readonly<Record<ParticipantId, TileSize>>,
  participantId: ParticipantId
): SimulcastPreference | null {
  return simulcastFor(tileSizeOf(sizes, participantId));
}

/**
 * A camera pull has landed. Its record is the layer the request asked
 * for, since that is what the SFU sends, even if the tile was resized
 * while the request was in flight; recording the tile's current layer
 * instead hides the drift from `planLayerUpdates` and leaves the camera
 * on the old layer for good (a new joiner pulled at medium, then shown
 * large, stays at half resolution). `resync` is whether the tile needs
 * another layer (or no video) by now.
 */
export function landedPull(
  sent: SimulcastPreference | null,
  sizesNow: Readonly<Record<ParticipantId, TileSize>>,
  participantId: ParticipantId
): { rid: Rid | null; resync: boolean } {
  const rid = sent?.preferredRid ?? null;
  return {
    rid,
    resync: ridForTileSize(tileSizeOf(sizesNow, participantId)) !== rid,
  };
}
