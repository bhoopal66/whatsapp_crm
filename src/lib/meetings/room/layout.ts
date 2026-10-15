/** One person in the room, as the tile layout needs them. */
export interface TileSource {
  participantId: string;
  userId: string;
  isSelf: boolean;
  /** Publishing a screen share right now. */
  sharing: boolean;
}

export interface Tile {
  key: string;
  participantId: string;
  userId: string;
  isSelf: boolean;
  kind: 'camera' | 'screen';
}

export interface TileLayout {
  /** The big tile: a screen share, if anyone is sharing. */
  featured: Tile | null;
  grid: Tile[];
  /** Grid columns for `grid.length` tiles. */
  columns: number;
}

/** Roughly square: 1, 2, 2, 2, 3 … 3, 4 … */
export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return 5;
}

/**
 * Tiles for the room: one camera tile per person (yourself first, then
 * in the order given), plus one per screen share. One share is
 * featured, someone else's ahead of your own (your own screen, blown
 * up, shows you nothing new); any further shares sit in the grid
 * beside their owner.
 */
export function tileLayout(sources: readonly TileSource[]): TileLayout {
  const ordered = [
    ...sources.filter((s) => s.isSelf),
    ...sources.filter((s) => !s.isSelf),
  ];
  const tile = (s: TileSource, kind: Tile['kind']): Tile => ({
    key: `${s.participantId}:${kind}`,
    participantId: s.participantId,
    userId: s.userId,
    isSelf: s.isSelf,
    kind,
  });
  const featuredSource =
    ordered.find((s) => s.sharing && !s.isSelf) ??
    ordered.find((s) => s.sharing) ??
    null;
  const grid: Tile[] = [];
  for (const s of ordered) {
    grid.push(tile(s, 'camera'));
    if (s.sharing && s !== featuredSource) grid.push(tile(s, 'screen'));
  }
  return {
    featured: featuredSource ? tile(featuredSource, 'screen') : null,
    grid,
    columns: gridColumns(grid.length),
  };
}
