// The meeting's pop-out: an always-on-top Document Picture-in-Picture
// window. What can be decided without a real window lives here;
// components/meetings/session/use-meeting-popout.tsx applies it.

import type { Size } from '@/lib/pbx/call-window';

export const POPOUT_SIZE_KEY = 'meetings:popout-size';
export const POPOUT_DEFAULT_SIZE: Size = { width: 420, height: 320 };
const MIN_SIDE = 160;
const MAX_SIDE = 4096;

/**
 * A stored size, safe to hand to requestWindow: its arguments are
 * range-enforced, so a negative or NaN value would throw there, and
 * localStorage is user-editable.
 */
export function readPopoutSize(raw: string | null): Size {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  const { width, height } = (v ?? {}) as { width?: unknown; height?: unknown };
  const side = (n: unknown) =>
    Math.round(Math.min(Math.max(n as number, MIN_SIDE), MAX_SIDE));
  return Number.isFinite(width) && Number.isFinite(height)
    ? { width: side(width), height: side(height) }
    : POPOUT_DEFAULT_SIZE;
}

export const writePopoutSize = (size: Size): string =>
  JSON.stringify({ width: size.width, height: size.height });

export type TileReporter = 'room' | 'popout' | 'float';

/**
 * Who tells the engine which camera layers to pull. One at a time: two
 * would overwrite each other's sizes on every render.
 */
export function tileReporter(
  onRoomPage: boolean,
  poppedOut: boolean
): TileReporter {
  if (onRoomPage) return 'room';
  return poppedOut ? 'popout' : 'float';
}

/**
 * A copied rule loses its stylesheet, and with it the base its relative
 * url()s resolved against: a font would 404 from the new document.
 */
export function absoluteCssUrls(css: string, base: string): string {
  return css.replace(
    /url\(\s*(['"]?)(?![a-z][a-z0-9+.-]*:|\/\/|#)([^'")]+)\1\s*\)/gi,
    (match, _quote, path: string) => {
      try {
        return `url("${new URL(path, base).href}")`;
      } catch {
        return match;
      }
    }
  );
}

/** The page's stylesheets, in order: a new window gets none of them. */
export function copyPageStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    const media = sheet.media?.mediaText ?? '';
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      const style = to.createElement('style');
      style.textContent = absoluteCssUrls(css, sheet.href ?? from.baseURI);
      if (media) style.media = media;
      to.head.appendChild(style);
    } catch {
      // A cross-origin sheet hides its rules, but it can still be linked.
      if (!sheet.href) continue;
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      if (media) link.media = media;
      to.head.appendChild(link);
    }
  }
}

export interface PopoutHolder {
  /** Rejects when the browser refuses the window. */
  open: () => Promise<void>;
  /** Closes the window, or abandons one still being requested. */
  close: () => void;
}

/**
 * Holds at most one window, and never one nobody wants any more: a
 * window that arrives after close() is shut on arrival, or it would sit
 * above every app showing a dead call. open() reaches `request` without
 * awaiting anything, because the browser demands the click's activation.
 */
export function createPopoutHolder(opts: {
  request: () => Promise<Window>;
  prepare: (win: Window) => void;
  onChange: (win: Window | null) => void;
}): PopoutHolder {
  let current: Window | null = null;
  let requesting = false;
  let wanted = 0;

  const forget = (win: Window) => {
    if (current !== win) return;
    current = null;
    opts.onChange(null);
  };

  return {
    open: async () => {
      if (current || requesting) return;
      requesting = true;
      const ticket = ++wanted;
      try {
        const win = await opts.request();
        if (ticket !== wanted) {
          win.close();
          return;
        }
        opts.prepare(win);
        current = win;
        win.addEventListener('pagehide', () => forget(win), { once: true });
        opts.onChange(win);
      } finally {
        requesting = false;
      }
    },
    close: () => {
      wanted += 1;
      const win = current;
      if (!win) return;
      forget(win);
      win.close();
    },
  };
}
