'use client';

// Corner resizing for the floating meeting window. The geometry is pure
// (lib/meetings/float/geometry.ts); moves go to the element's style on
// an animation frame, never through React state, and only the release
// reports. hold/settle are useFloatingWindow's, whose placement would
// otherwise fight the drag.

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import {
  resizeByKey,
  resizeFromCorner,
  type FloatCorner,
} from '@/lib/meetings/float/geometry';
import { isNudgeKey, type Rect } from '@/lib/pbx/call-window';

interface Session {
  pointerId: number;
  corner: FloatCorner;
  x: number;
  y: number;
  start: Rect;
  rect: Rect;
  frame: number | null;
  userSelect: string;
}

const viewport = () => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: window.innerHeight,
});

const write = (el: HTMLElement, r: Rect) => {
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
};

export function useResizableWindow({
  element,
  hold,
  onResized,
}: {
  element: () => HTMLElement | null;
  hold: () => void;
  /** Once per gesture, with the final rect. */
  onResized: (rect: Rect) => void;
}) {
  const session = useRef<Session | null>(null);

  const stop = (s: Session) => {
    session.current = null;
    if (s.frame !== null) cancelAnimationFrame(s.frame);
    document.body.style.userSelect = s.userSelect;
  };

  // Minimising or unmounting mid-drag leaves no app-wide user-select.
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      if (s.frame !== null) cancelAnimationFrame(s.frame);
      document.body.style.userSelect = s.userSelect;
    },
    []
  );

  const finish = (e: PointerEvent<HTMLElement>) => {
    const s = session.current;
    const el = element();
    if (!s || s.pointerId !== e.pointerId) return;
    stop(s);
    if (el) write(el, s.rect);
    onResized(s.rect);
  };

  return (corner: FloatCorner) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const el = element();
      if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const start = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
      hold();
      session.current = {
        pointerId: e.pointerId,
        corner,
        x: e.clientX,
        y: e.clientY,
        start,
        rect: start,
        frame: null,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.userSelect = 'none';
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = session.current;
      const el = element();
      if (!s || !el || s.pointerId !== e.pointerId) return;
      s.rect = resizeFromCorner(
        s.start,
        s.corner,
        e.clientX - s.x,
        e.clientY - s.y,
        viewport()
      );
      if (s.frame === null)
        s.frame = requestAnimationFrame(() => {
          s.frame = null;
          write(el, s.rect);
        });
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const el = element();
      if (!el || !isNudgeKey(e.key)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      hold();
      const next = resizeByKey(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        corner,
        e.key,
        e.shiftKey,
        viewport()
      );
      write(el, next);
      onResized(next);
    },
  });
}
