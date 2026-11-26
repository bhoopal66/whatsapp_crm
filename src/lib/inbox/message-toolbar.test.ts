import { describe, expect, it, vi } from 'vitest';

import {
  createOpenSlot,
  leftPress,
  startsLongPress,
  swallowsClick,
} from './message-toolbar';

describe('startsLongPress', () => {
  const finger = { pointerType: 'touch', isPrimary: true, onControl: false };

  it('times a finger held on the message', () => {
    expect(startsLongPress(finger)).toBe(true);
  });

  it('leaves mouse and pen to the right-click menu', () => {
    expect(startsLongPress({ ...finger, pointerType: 'mouse' })).toBe(false);
    expect(startsLongPress({ ...finger, pointerType: 'pen' })).toBe(false);
  });

  it('ignores a second finger, and a control being held', () => {
    expect(startsLongPress({ ...finger, isPrimary: false })).toBe(false);
    expect(startsLongPress({ ...finger, onControl: true })).toBe(false);
  });
});

describe('leftPress', () => {
  it('forgives a wobble and cancels on a drag either way', () => {
    const start = { x: 100, y: 100 };
    expect(leftPress(start, { x: 104, y: 95 })).toBe(false);
    expect(leftPress(start, { x: 100, y: 111 })).toBe(true);
    expect(leftPress(start, { x: 89, y: 100 })).toBe(true);
  });
});

describe('swallowsClick', () => {
  const tap = {
    afterLongPress: false,
    onToolbar: true,
    pressedOn: 'message' as const,
    keyboard: false,
  };

  it('stops a tap on the message that ends on a toolbar button', () => {
    expect(swallowsClick(tap)).toBe(true);
  });

  it('lets a tap that began on the toolbar through', () => {
    expect(swallowsClick({ ...tap, pressedOn: 'toolbar' })).toBe(false);
  });

  it('lets an ordinary tap on the message through', () => {
    expect(swallowsClick({ ...tap, onToolbar: false })).toBe(false);
  });

  it('stops the click of the long press itself, wherever it lands', () => {
    expect(
      swallowsClick({ ...tap, onToolbar: false, afterLongPress: true })
    ).toBe(true);
    expect(
      swallowsClick({ ...tap, pressedOn: 'toolbar', afterLongPress: true })
    ).toBe(true);
  });

  it('never stops the keyboard or assistive tech', () => {
    expect(
      swallowsClick({ ...tap, afterLongPress: true, keyboard: true })
    ).toBe(false);
    expect(swallowsClick({ ...tap, pressedOn: null })).toBe(false);
  });
});

describe('createOpenSlot', () => {
  it('closes the toolbar that was open when another opens', () => {
    const slot = createOpenSlot();
    const a = vi.fn();
    const b = vi.fn();
    slot.claim(a);
    slot.claim(b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('does not close the one re-opening, or one already closed', () => {
    const slot = createOpenSlot();
    const a = vi.fn();
    const b = vi.fn();
    slot.claim(a);
    slot.claim(a);
    slot.release(b);
    slot.release(a);
    slot.claim(b);
    expect(a).not.toHaveBeenCalled();
  });
});
