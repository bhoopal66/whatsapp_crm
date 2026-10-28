// ============================================================
// Where the floating call windows sit (module 015): the in-call window
// and the ringing card. Pure, so the placement rules are tested without
// a DOM; the hook in components/pbx/use-floating-window.ts applies them.
//
// A position is anchored to the nearest viewport corner, as offsets from
// that corner's two edges, so a window parked bottom-right stays
// bottom-right when the browser is resized and grows up and to the left
// when its content does. Every placement is clamped so the whole window
// stays on screen with a margin; one larger than the viewport pins to
// the top/left margin, where its header (the drag handle) stays
// reachable. Stored prefs are read defensively: localStorage is
// user-editable.
// ============================================================

export interface Anchor {
  h: 'left' | 'right';
  v: 'top' | 'bottom';
  /** px from the anchored corner's vertical edge (left or right). */
  dx: number;
  /** px from the anchored corner's horizontal edge (top or bottom). */
  dy: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

/** Kept clear between a window and every viewport edge. */
export const WINDOW_MARGIN = 12;
/** Arrow-key nudge, and with Shift. */
export const NUDGE_PX = 16;
export const NUDGE_SHIFT_PX = 64;

/** The in-call window's first spot: bottom-right, out of the content. */
export const CALL_WINDOW_DEFAULT: Anchor = {
  h: 'right',
  v: 'bottom',
  dx: 16,
  dy: 16,
};
/** The ringing card's first spot: top-right below the header, as before. */
export const RING_CARD_DEFAULT: Anchor = {
  h: 'right',
  v: 'top',
  dx: 16,
  dy: 68,
};

const clampAxis = (start: number, size: number, viewport: number): number => {
  const max = viewport - size - WINDOW_MARGIN;
  // Larger than the viewport: pin to the start margin.
  if (max < WINDOW_MARGIN) return WINDOW_MARGIN;
  return Math.min(Math.max(start, WINDOW_MARGIN), max);
};

/** A window's top-left, clamped inside the viewport. */
export function clampPlace(
  place: { left: number; top: number },
  size: Size,
  viewport: Size
): { left: number; top: number } {
  return {
    left: clampAxis(place.left, size.width, viewport.width),
    top: clampAxis(place.top, size.height, viewport.height),
  };
}

/** Where an anchored window of `size` sits in `viewport`. */
export function placeOf(
  anchor: Anchor,
  size: Size,
  viewport: Size
): { left: number; top: number } {
  const left =
    anchor.h === 'left' ? anchor.dx : viewport.width - anchor.dx - size.width;
  const top =
    anchor.v === 'top' ? anchor.dy : viewport.height - anchor.dy - size.height;
  return clampPlace({ left, top }, size, viewport);
}

/** The nearest-corner anchor of a window at `rect`. */
export function anchorOf(rect: Rect, viewport: Size): Anchor {
  const h = rect.left + rect.width / 2 < viewport.width / 2 ? 'left' : 'right';
  const v = rect.top + rect.height / 2 < viewport.height / 2 ? 'top' : 'bottom';
  return {
    h,
    v,
    dx: Math.max(
      0,
      Math.round(
        h === 'left' ? rect.left : viewport.width - rect.left - rect.width
      )
    ),
    dy: Math.max(
      0,
      Math.round(
        v === 'top' ? rect.top : viewport.height - rect.top - rect.height
      )
    ),
  };
}

/** The anchor of `anchor` once clamped: what a drag end or nudge stores. */
export function clampAnchor(
  anchor: Anchor,
  size: Size,
  viewport: Size
): Anchor {
  return anchorOf({ ...placeOf(anchor, size, viewport), ...size }, viewport);
}

export type NudgeKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export const isNudgeKey = (key: string): key is NudgeKey =>
  key === 'ArrowLeft' ||
  key === 'ArrowRight' ||
  key === 'ArrowUp' ||
  key === 'ArrowDown';

/** The anchor after one arrow-key step (64px with Shift), clamped. */
export function nudge(
  anchor: Anchor,
  key: NudgeKey,
  shift: boolean,
  size: Size,
  viewport: Size
): Anchor {
  const step = shift ? NUDGE_SHIFT_PX : NUDGE_PX;
  const at = placeOf(anchor, size, viewport);
  const left =
    at.left + (key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0);
  const top =
    at.top + (key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
  return anchorOf(
    { ...clampPlace({ left, top }, size, viewport), ...size },
    viewport
  );
}

export interface WindowPrefs {
  /** Null: never moved (or unreadable), so the default spot. */
  anchor: Anchor | null;
  minimized: boolean;
}

const offset = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null;

/** Stored prefs, read defensively; anything unreadable is the default. */
export function readWindowPrefs(raw: string | null): WindowPrefs {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return { anchor: null, minimized: false };
  const o = v as Record<string, unknown>;
  const a = o.anchor as Record<string, unknown> | null | undefined;
  let anchor: Anchor | null = null;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const dx = offset(a.dx);
    const dy = offset(a.dy);
    if (
      (a.h === 'left' || a.h === 'right') &&
      (a.v === 'top' || a.v === 'bottom') &&
      dx !== null &&
      dy !== null
    )
      anchor = { h: a.h, v: a.v, dx, dy };
  }
  return { anchor, minimized: o.minimized === true };
}

export const writeWindowPrefs = (prefs: WindowPrefs): string =>
  JSON.stringify({ anchor: prefs.anchor, minimized: prefs.minimized });
