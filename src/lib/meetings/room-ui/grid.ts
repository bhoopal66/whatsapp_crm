// Gallery maths for the meeting room: how many columns and rows fit N
// tiles of one aspect ratio into a W×H stage, and how big each one is.
// Pure, so the node test env can pin it.

export interface GridFit {
  columns: number;
  rows: number;
  /** CSS pixels. */
  tileWidth: number;
  tileHeight: number;
}

/** Tiles per gallery page; beyond this the gallery paginates. */
export const GALLERY_PAGE_SIZE = 16;

/**
 * The column count that gives the largest tiles: for each candidate,
 * the tile is as wide as a column allows, or as tall as a row allows,
 * whichever is smaller at `aspect` (width / height).
 */
export function fitGrid(
  count: number,
  width: number,
  height: number,
  gap = 8,
  aspect = 16 / 9
): GridFit {
  const n = Math.max(1, Math.floor(count));
  if (!(width > 0) || !(height > 0)) {
    return {
      columns: Math.ceil(Math.sqrt(n)),
      rows: Math.ceil(n / Math.ceil(Math.sqrt(n))),
      tileWidth: 0,
      tileHeight: 0,
    };
  }
  let best: GridFit = { columns: 1, rows: n, tileWidth: 0, tileHeight: 0 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const byWidth = (width - gap * (columns - 1)) / columns;
    const byHeight = ((height - gap * (rows - 1)) / rows) * aspect;
    const tileWidth = Math.max(0, Math.min(byWidth, byHeight));
    if (tileWidth > best.tileWidth) {
      best = { columns, rows, tileWidth, tileHeight: tileWidth / aspect };
    }
  }
  return {
    ...best,
    tileWidth: Math.floor(best.tileWidth),
    tileHeight: Math.floor(best.tileHeight),
  };
}

/** 16:9, except a portrait phone, where 3:4 tiles use the screen. */
export function tileAspect(width: number, height: number): number {
  return width <= 640 && height > width ? 3 / 4 : 16 / 9;
}

export interface Page<T> {
  items: T[];
  /** Clamped into range. */
  page: number;
  pageCount: number;
}

export function paginate<T>(
  items: readonly T[],
  page: number,
  perPage = GALLERY_PAGE_SIZE
): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1);
  return {
    items: items.slice(p * perPage, (p + 1) * perPage),
    page: p,
    pageCount,
  };
}
