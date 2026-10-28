'use client';

// A floating, draggable window for the call screens (module 015): the
// in-call window and the ringing card. The placement rules are pure
// (lib/pbx/call-window.ts); this hook measures, drags and remembers.
//
// - The window is anchored to its nearest viewport corner, re-placed
//   (clamped) whenever its own size changes (minimise, a tab, the
//   transfer row) or the viewport does, so a bottom-right window grows
//   up and to the left and never leaves the screen.
// - A drag only starts after 3px of movement and never from an
//   interactive element, so every button in the handle still clicks.
//   During the drag the position is written to the element's style on
//   an animation frame, never through React state.
// - The spot and the minimised state persist on drag end, nudge, reset
//   and minimise toggle, not on every move. Storage may be blocked
//   (private windows): every access falls back to the defaults.
// - Below the `sm` breakpoint there is no free dragging: the component
//   lays itself out as a bottom sheet / bar instead (`mobile`).

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  anchorOf,
  clampPlace,
  isNudgeKey,
  nudge,
  placeOf,
  readWindowPrefs,
  writeWindowPrefs,
  type Anchor,
  type WindowPrefs,
} from '@/lib/pbx/call-window';

const DRAG_THRESHOLD_PX = 3;
const MOBILE_QUERY = '(max-width: 639px)';
/** Never starts a drag: the handle's own controls keep working. */
const NO_DRAG =
  'button, a, input, textarea, select, label, [role="radio"], [role="tab"], [data-no-drag]';

function readPrefs(key: string): WindowPrefs {
  try {
    return readWindowPrefs(window.localStorage.getItem(key));
  } catch {
    return { anchor: null, minimized: false };
  }
}

function writePrefs(key: string, prefs: WindowPrefs) {
  try {
    window.localStorage.setItem(key, writeWindowPrefs(prefs));
  } catch {
    // Blocked storage: the window just forgets its spot.
  }
}

const subscribeMobile = (cb: () => void) => {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const mobileNow = () => window.matchMedia(MOBILE_QUERY).matches;

const viewport = () => ({
  // clientWidth leaves out a page scrollbar.
  width: document.documentElement.clientWidth || window.innerWidth,
  height: window.innerHeight,
});

const sizeOf = (el: HTMLElement) => ({
  width: el.offsetWidth,
  height: el.offsetHeight,
});

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  moving: boolean;
  frame: number | null;
  at: { left: number; top: number };
}

export interface FloatingWindowOptions {
  /** localStorage key: `pbx:call-window`, `pbx:ring-card`. */
  storageKey: string;
  defaultAnchor: Anchor;
  /** Accessible name of the drag handle ("Move call window"). */
  label: string;
  /** Translated aria-roledescription of the handle ("draggable"). */
  roleDescription: string;
}

export function useFloatingWindow({
  storageKey,
  defaultAnchor,
  label,
  roleDescription,
}: FloatingWindowOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Held in state too: the ringing card's element comes and goes with
  // the call while the hook stays mounted, and each one is observed.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const setRef = useCallback((n: HTMLDivElement | null) => {
    ref.current = n;
    setNode(n);
  }, []);
  // The card and the panel mount only on the client once a call is on
  // screen, and the spot is applied in a layout effect, never rendered:
  // reading storage here cannot disagree with a server render.
  const [initial] = useState(() =>
    typeof window === 'undefined'
      ? { anchor: null, minimized: false }
      : readPrefs(storageKey)
  );
  const [anchor, setAnchor] = useState<Anchor>(initial.anchor ?? defaultAnchor);
  const [minimized, setMinimizedState] = useState(initial.minimized);
  const [dragging, setDragging] = useState(false);
  const mobile = useSyncExternalStore(subscribeMobile, mobileNow, () => false);
  const drag = useRef<Drag | null>(null);
  // The latest values, for the observers and handlers.
  const state = useRef({ anchor, minimized, mobile });
  useLayoutEffect(() => {
    state.current = { anchor, minimized, mobile };
  });

  const apply = useCallback(() => {
    const el = ref.current;
    if (!el || drag.current?.moving) return;
    if (state.current.mobile) {
      el.style.left = '';
      el.style.top = '';
      return;
    }
    const at = placeOf(state.current.anchor, sizeOf(el), viewport());
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  }, []);

  // Before paint, on every render: a new anchor, minimised, the
  // breakpoint, and content that changed the window's size.
  useLayoutEffect(apply);

  useLayoutEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver(apply);
    ro.observe(node);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [apply, node]);

  const persist = useCallback(
    (next: Partial<WindowPrefs>) => {
      writePrefs(storageKey, {
        anchor: next.anchor !== undefined ? next.anchor : state.current.anchor,
        minimized: next.minimized ?? state.current.minimized,
      });
    },
    [storageKey]
  );

  const setMinimized = useCallback(
    (next: boolean) => {
      setMinimizedState(next);
      persist({ minimized: next });
    },
    [persist]
  );

  const reset = useCallback(() => {
    setAnchor(defaultAnchor);
    persist({ anchor: null });
  }, [defaultAnchor, persist]);

  const settle = (next: Anchor) => {
    setAnchor(next);
    persist({ anchor: next });
  };

  const endDrag = (e: PointerEvent<HTMLElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (!d.moving) return;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = '';
    setDragging(false);
    const el = ref.current;
    if (!el) return;
    const size = sizeOf(el);
    const vp = viewport();
    if (keep) settle(anchorOf({ ...d.at, ...size }, vp));
    else apply();
  };

  const handleProps = {
    role: 'group',
    tabIndex: 0,
    'aria-roledescription': roleDescription,
    'aria-label': label,
    style: mobile
      ? undefined
      : ({
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
        } satisfies CSSProperties),
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (mobile || !ref.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as Element).closest(NO_DRAG)) return;
      const r = ref.current.getBoundingClientRect();
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: r.left,
        top: r.top,
        moving: false,
        frame: null,
        at: { left: r.left, top: r.top },
      };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el || d.pointerId !== e.pointerId) return;
      const mx = e.clientX - d.startX;
      const my = e.clientY - d.startY;
      if (!d.moving) {
        if (Math.hypot(mx, my) < DRAG_THRESHOLD_PX) return;
        d.moving = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.style.userSelect = 'none';
        setDragging(true);
      }
      e.preventDefault();
      d.at = clampPlace(
        { left: d.left + mx, top: d.top + my },
        sizeOf(el),
        viewport()
      );
      if (d.frame === null)
        d.frame = requestAnimationFrame(() => {
          d.frame = null;
          el.style.left = `${d.at.left}px`;
          el.style.top = `${d.at.top}px`;
        });
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => endDrag(e, true),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => endDrag(e, false),
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => endDrag(e, true),
    onDoubleClick: (e: React.MouseEvent<HTMLElement>) => {
      if (mobile || (e.target as Element).closest(NO_DRAG)) return;
      reset();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Only the handle itself: arrows in a field inside it stay the field's.
      if (mobile || e.target !== e.currentTarget || !ref.current) return;
      if (!isNudgeKey(e.key)) return;
      e.preventDefault();
      settle(nudge(anchor, e.key, e.shiftKey, sizeOf(ref.current), viewport()));
    },
  };

  return {
    /** On the window's root element (the same element minimised or not). */
    attach: setRef,
    /** Spread on the drag handle. */
    handleProps,
    minimized,
    setMinimized,
    reset,
    mobile,
    dragging,
  };
}
