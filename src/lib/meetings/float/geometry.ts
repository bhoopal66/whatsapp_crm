// The floating meeting window's size, and how a corner drag changes it.
// Pure; components/meetings/session/use-resizable-window.ts applies it.
// Stored sizes are read defensively: localStorage is user-editable.

import {
  NUDGE_PX,
  NUDGE_SHIFT_PX,
  WINDOW_MARGIN,
  type NudgeKey,
  type Rect,
  type Size,
} from '@/lib/pbx/call-window';

export const FLOAT_SIZE_KEY = 'meetings:float-size';
export const FLOAT_DEFAULT_SIZE: Size = { width: 360, height: 270 };
export const FLOAT_MIN_SIZE: Size = { width: 280, height: 210 };
const MAX_W = 760;
const MAX_H = 600;

export type FloatCorner = 'nw' | 'ne' | 'sw' | 'se';

const within = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

export function floatMaxSize(viewport: Size): Size {
  return {
    width: Math.min(MAX_W, viewport.width - 2 * WINDOW_MARGIN),
    height: Math.min(MAX_H, viewport.height - 2 * WINDOW_MARGIN),
  };
}

export function clampFloatSize(size: Size, viewport: Size): Size {
  const max = floatMaxSize(viewport);
  return {
    width: within(size.width, FLOAT_MIN_SIZE.width, max.width),
    height: within(size.height, FLOAT_MIN_SIZE.height, max.height),
  };
}

/** One axis; `near` means the dragged edge is the left or the top. */
function axis(
  at: number,
  length: number,
  delta: number,
  near: boolean,
  min: number,
  max: number,
  room: number
) {
  if (near) {
    const end = at + length;
    const next = within(
      length - delta,
      min,
      Math.min(max, end - WINDOW_MARGIN)
    );
    return { at: end - next, length: next };
  }
  const limit = Math.min(max, room - WINDOW_MARGIN - at);
  return { at, length: within(length + delta, min, limit) };
}

/** `start` with `corner` dragged by (dx, dy); the opposite corner stays. */
export function resizeFromCorner(
  start: Rect,
  corner: FloatCorner,
  dx: number,
  dy: number,
  viewport: Size
): Rect {
  const max = floatMaxSize(viewport);
  const { width: minW, height: minH } = FLOAT_MIN_SIZE;
  const west = corner.endsWith('w');
  const north = corner.startsWith('n');
  const x = axis(
    start.left,
    start.width,
    dx,
    west,
    minW,
    max.width,
    viewport.width
  );
  const y = axis(
    start.top,
    start.height,
    dy,
    north,
    minH,
    max.height,
    viewport.height
  );
  return { left: x.at, top: y.at, width: x.length, height: y.length };
}

/** One arrow-key step of a grip: the corner moves that way. */
export function resizeByKey(
  start: Rect,
  corner: FloatCorner,
  key: NudgeKey,
  shift: boolean,
  viewport: Size
): Rect {
  const step = shift ? NUDGE_SHIFT_PX : NUDGE_PX;
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  return resizeFromCorner(start, corner, dx, dy, viewport);
}

export function readFloatSize(raw: string | null): Size {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  const o = (v ?? {}) as { width?: unknown; height?: unknown };
  return Number.isFinite(o.width) && Number.isFinite(o.height)
    ? { width: o.width as number, height: o.height as number }
    : FLOAT_DEFAULT_SIZE;
}

export const writeFloatSize = (size: Size): string =>
  JSON.stringify({ width: size.width, height: size.height });
