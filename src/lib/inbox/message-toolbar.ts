/**
 * The rules behind a message's touch toolbar
 * (`components/inbox/message-actions.tsx`), which floats over the top of
 * every bubble.
 */

/**
 * A little under the half second iOS takes to start selecting text,
 * which cancels the pointer.
 */
export const LONG_PRESS_MS = 450;
/** A finger is never perfectly still; further than this is a scroll. */
export const LONG_PRESS_SLOP_PX = 10;

/** Elements a held finger already means something to. */
export const HOLD_CONTROL_SELECTOR =
  'input, textarea, select, audio, video, [role="slider"], [data-message-toolbar]';

/** Does this press start the long-press timer? */
export function startsLongPress(press: {
  pointerType: string;
  isPrimary: boolean;
  /** On a control of its own (HOLD_CONTROL_SELECTOR). */
  onControl: boolean;
}): boolean {
  return press.pointerType === 'touch' && press.isPrimary && !press.onControl;
}

/** Has the finger moved too far to be a press? */
export function leftPress(
  start: { x: number; y: number },
  now: { x: number; y: number }
): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > LONG_PRESS_SLOP_PX;
}

/**
 * Must this click not reach the message or its toolbar? The browser
 * re-aims a tap's click after the toolbar appeared: the release of a
 * long press, and a tap that a hybrid device also reports as a hover,
 * would land on whichever button came up under the finger.
 */
export function swallowsClick(click: {
  /** The press it ends opened the toolbar. */
  afterLongPress: boolean;
  /** It landed on the toolbar. */
  onToolbar: boolean;
  /** Where its press began; null when no press is known. */
  pressedOn: 'toolbar' | 'message' | null;
  /** From the keyboard or a script (`detail` 0). */
  keyboard: boolean;
}): boolean {
  if (click.keyboard) return false;
  if (click.afterLongPress) return true;
  return click.onToolbar && click.pressedOn === 'message';
}

/** Holds the one open toolbar's close call; claiming closes the last. */
export function createOpenSlot() {
  let current: (() => void) | null = null;
  return {
    claim(close: () => void) {
      const last = current;
      current = close;
      if (last && last !== close) last();
    },
    release(close: () => void) {
      if (current === close) current = null;
    },
  };
}
