import { describe, expect, it } from 'vitest';
import {
  CALL_WINDOW_DEFAULT,
  RING_CARD_DEFAULT,
  WINDOW_MARGIN,
  anchorOf,
  clampAnchor,
  nudge,
  placeOf,
  readWindowPrefs,
  writeWindowPrefs,
  type Anchor,
} from './call-window';

const vp = { width: 1440, height: 900 };
const size = { width: 400, height: 500 };

describe('placeOf / anchorOf', () => {
  it('places the default bottom-right window 16px from both edges', () => {
    expect(placeOf(CALL_WINDOW_DEFAULT, size, vp)).toEqual({
      left: 1440 - 16 - 400,
      top: 900 - 16 - 500,
    });
  });

  it('keeps the ringing card where it was: top-right below the header', () => {
    expect(placeOf(RING_CARD_DEFAULT, { width: 380, height: 300 }, vp)).toEqual(
      { left: 1440 - 16 - 380, top: 68 }
    );
  });

  it('round-trips an anchor through a placement, in every corner', () => {
    const corners: Anchor[] = [
      { h: 'left', v: 'top', dx: 40, dy: 80 },
      { h: 'right', v: 'top', dx: 30, dy: 70 },
      { h: 'left', v: 'bottom', dx: 20, dy: 60 },
      { h: 'right', v: 'bottom', dx: 16, dy: 16 },
    ];
    for (const a of corners)
      expect(anchorOf({ ...placeOf(a, size, vp), ...size }, vp)).toEqual(a);
  });

  it('anchors to the nearest corner by the window centre', () => {
    expect(anchorOf({ left: 100, top: 50, ...size }, vp)).toMatchObject({
      h: 'left',
      v: 'top',
    });
    expect(anchorOf({ left: 1000, top: 380, ...size }, vp)).toMatchObject({
      h: 'right',
      v: 'bottom',
      dx: 40,
      dy: 20,
    });
  });

  it('a resize keeps the offsets from the anchored corner', () => {
    const a: Anchor = { h: 'right', v: 'bottom', dx: 24, dy: 32 };
    const small = { width: 1024, height: 700 };
    const at = placeOf(a, size, small);
    expect(at).toEqual({ left: 1024 - 24 - 400, top: 700 - 32 - 500 });
    expect(anchorOf({ ...at, ...size }, small)).toEqual(a);
  });

  it('growing keeps a bottom-right corner: up and to the left', () => {
    const a: Anchor = { h: 'right', v: 'bottom', dx: 16, dy: 16 };
    const pill = placeOf(a, { width: 320, height: 48 }, vp);
    const full = placeOf(a, size, vp);
    expect(pill.left + 320).toBe(full.left + 400);
    expect(pill.top + 48).toBe(full.top + 500);
  });
});

describe('clamping', () => {
  it('clamps on the left and top edges', () => {
    expect(placeOf({ h: 'left', v: 'top', dx: 0, dy: 2 }, size, vp)).toEqual({
      left: WINDOW_MARGIN,
      top: WINDOW_MARGIN,
    });
  });

  it('clamps on the right and bottom edges', () => {
    expect(
      placeOf({ h: 'right', v: 'bottom', dx: 0, dy: 0 }, size, vp)
    ).toEqual({
      left: 1440 - 400 - WINDOW_MARGIN,
      top: 900 - 500 - WINDOW_MARGIN,
    });
  });

  it('clamps an offset that would push the window off the far edge', () => {
    expect(
      placeOf({ h: 'left', v: 'top', dx: 5000, dy: 5000 }, size, vp)
    ).toEqual({
      left: 1440 - 400 - WINDOW_MARGIN,
      top: 900 - 500 - WINDOW_MARGIN,
    });
  });

  it('pins a window larger than the viewport to the top/left margin', () => {
    const tiny = { width: 300, height: 400 };
    expect(placeOf(CALL_WINDOW_DEFAULT, size, tiny)).toEqual({
      left: WINDOW_MARGIN,
      top: WINDOW_MARGIN,
    });
  });

  it('clampAnchor stores the clamped offsets', () => {
    expect(
      clampAnchor({ h: 'right', v: 'bottom', dx: 0, dy: 0 }, size, vp)
    ).toEqual({
      h: 'right',
      v: 'bottom',
      dx: WINDOW_MARGIN,
      dy: WINDOW_MARGIN,
    });
  });
});

describe('nudge', () => {
  const a: Anchor = { h: 'right', v: 'bottom', dx: 100, dy: 100 };

  it('moves 16px per arrow key', () => {
    expect(nudge(a, 'ArrowLeft', false, size, vp)).toEqual({ ...a, dx: 116 });
    expect(nudge(a, 'ArrowRight', false, size, vp)).toEqual({ ...a, dx: 84 });
    expect(nudge(a, 'ArrowUp', false, size, vp)).toEqual({ ...a, dy: 116 });
    expect(nudge(a, 'ArrowDown', false, size, vp)).toEqual({ ...a, dy: 84 });
  });

  it('moves 64px with Shift', () => {
    expect(nudge(a, 'ArrowUp', true, size, vp)).toEqual({ ...a, dy: 164 });
  });

  it('stops at the margin', () => {
    const edge: Anchor = { h: 'right', v: 'bottom', dx: 20, dy: 20 };
    expect(nudge(edge, 'ArrowRight', true, size, vp)).toEqual({
      ...edge,
      dx: WINDOW_MARGIN,
    });
  });
});

describe('readWindowPrefs / writeWindowPrefs', () => {
  const none = { anchor: null, minimized: false };

  it('round-trips', () => {
    const prefs = {
      anchor: { h: 'left', v: 'top', dx: 30, dy: 40 } as Anchor,
      minimized: true,
    };
    expect(readWindowPrefs(writeWindowPrefs(prefs))).toEqual(prefs);
  });

  it('reads null, garbage and the wrong JSON types as the defaults', () => {
    for (const raw of [null, '', '{', 'null', '42', '"x"', '[1,2]', 'true'])
      expect(readWindowPrefs(raw)).toEqual(none);
  });

  it('drops an anchor with a bad corner or a non-numeric offset', () => {
    for (const anchor of [
      { h: 'middle', v: 'top', dx: 1, dy: 1 },
      { h: 'left', v: 'up', dx: 1, dy: 1 },
      { h: 'left', v: 'top', dx: '10', dy: 1 },
      { h: 'left', v: 'top', dx: 1 },
      [1, 2],
      'left',
    ])
      expect(
        readWindowPrefs(JSON.stringify({ anchor, minimized: true }))
      ).toEqual({ anchor: null, minimized: true });
  });

  it('drops NaN and Infinity (which JSON stores as null)', () => {
    expect(
      readWindowPrefs('{"anchor":{"h":"left","v":"top","dx":null,"dy":1e999}}')
        .anchor
    ).toBeNull();
  });

  it('reads a negative offset as 0, and a truthy non-boolean as not minimised', () => {
    expect(
      readWindowPrefs(
        JSON.stringify({
          anchor: { h: 'right', v: 'bottom', dx: -50, dy: 8 },
          minimized: 'yes',
        })
      )
    ).toEqual({
      anchor: { h: 'right', v: 'bottom', dx: 0, dy: 8 },
      minimized: false,
    });
  });

  it('reads a partial shape: minimised without an anchor', () => {
    expect(readWindowPrefs('{"minimized":true}')).toEqual({
      anchor: null,
      minimized: true,
    });
  });
});
