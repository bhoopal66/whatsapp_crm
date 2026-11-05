import { describe, expect, it } from 'vitest';

import type { Rect } from '@/lib/pbx/call-window';

import {
  floatFocus,
  floatTileSizes,
  otherPeople,
  speakerLine,
  type FloatFocusInput,
} from './focus';
import {
  clampFloatSize,
  FLOAT_DEFAULT_SIZE,
  readFloatSize,
  resizeByKey,
  resizeFromCorner,
  writeFloatSize,
  type FloatCorner,
} from './geometry';

const base: FloatFocusInput = {
  selfId: 'me',
  participantIds: ['me', 'a', 'b'],
  activeSpeakerId: null,
  lastRemoteSpeakerId: null,
  view: 'speaker',
  receivedScreens: new Set(),
};

describe('floatFocus', () => {
  it('shows the remote active speaker', () => {
    expect(floatFocus({ ...base, activeSpeakerId: 'b' }).mainId).toBe('b');
  });
  it('keeps the last remote speaker while we speak', () => {
    const f = { ...base, activeSpeakerId: 'me', lastRemoteSpeakerId: 'b' };
    expect(floatFocus(f).mainId).toBe('b');
  });
  it('shows the first remote person when nobody spoke, or they left', () => {
    expect(floatFocus(base).mainId).toBe('a');
    expect(floatFocus({ ...base, lastRemoteSpeakerId: 'z' }).mainId).toBe('a');
  });
  it('shows ourselves when alone', () => {
    expect(floatFocus({ ...base, participantIds: ['me'] })).toMatchObject({
      mainId: 'me',
      alone: true,
      kind: 'camera',
    });
  });
  it('shows a screen only when chosen and received', () => {
    const receivedScreens = new Set(['b']);
    expect(floatFocus({ ...base, view: 'screen' }).kind).toBe('camera');
    expect(floatFocus({ ...base, receivedScreens }).kind).toBe('camera');
    expect(
      floatFocus({
        ...base,
        view: 'screen',
        receivedScreens,
        activeSpeakerId: 'a',
      })
    ).toMatchObject({ kind: 'screen', mainId: 'b', speakerId: 'a' });
  });
  it('never features our own screen', () => {
    expect(
      floatFocus({ ...base, view: 'screen', receivedScreens: new Set(['me']) })
    ).toMatchObject({ kind: 'camera', screenId: null, mainId: 'a' });
  });
});

describe('floatTileSizes', () => {
  const sizes = {
    participantIds: ['me', 'a', 'b'],
    selfId: 'me',
    mainCameraId: 'a',
    stageHeight: 400,
    dpr: 1,
    minimized: false,
  };
  const crowd = (n: number) => ({
    ...sizes,
    participantIds: ['me', ...Array.from({ length: n }, (_, i) => `p${i}`)],
    mainCameraId: 'p0',
  });
  it('draws the main large, warms the others, leaves ourselves out', () => {
    expect(floatTileSizes(sizes)).toEqual({ a: 'large', b: 'small' });
  });
  it('never drops the main below medium', () => {
    expect(floatTileSizes({ ...sizes, stageHeight: 100 }).a).toBe('medium');
  });
  it('closes the others above eight remote people', () => {
    expect(floatTileSizes(crowd(8)).p1).toBe('small');
    expect(floatTileSizes(crowd(9))).toMatchObject({
      p0: 'large',
      p1: 'hidden',
    });
  });
  it('hides every camera when minimised', () => {
    expect(floatTileSizes({ ...sizes, minimized: true })).toEqual({
      a: 'hidden',
      b: 'hidden',
    });
  });
  it('keeps cameras small under a screen', () => {
    expect(floatTileSizes({ ...sizes, mainCameraId: null })).toEqual({
      a: 'small',
      b: 'small',
    });
  });
});

describe('otherPeople and speakerLine', () => {
  const p = (id: string, speaking = false, handRaised = false) => ({
    id,
    speaking,
    handRaised,
  });
  it('orders speaking, hands, join order and caps', () => {
    const out = otherPeople(
      [p('me'), p('m'), p('a'), p('b', false, true), p('c', true)],
      ['me', 'm'],
      2
    );
    expect(out.shown.map((x) => x.id)).toEqual(['c', 'b']);
    expect(out.extra).toBe(1);
  });
  it('names a remote speaker only while they speak', () => {
    const name = (id: string) => id.toUpperCase();
    expect(speakerLine('a', { a: true }, 'me', name)).toBe('A');
    expect(speakerLine('a', {}, 'me', name)).toBeNull();
    expect(speakerLine('me', { me: true }, 'me', name)).toBeNull();
  });
});

describe('float geometry', () => {
  const vp = { width: 1280, height: 800 };
  const start: Rect = { left: 500, top: 300, width: 360, height: 270 };
  const fixed = (r: Rect, c: FloatCorner) => ({
    x: c.endsWith('w') ? r.left + r.width : r.left,
    y: c.startsWith('n') ? r.top + r.height : r.top,
  });
  it.each<FloatCorner>(['nw', 'ne', 'sw', 'se'])(
    'keeps the corner opposite %s fixed, inside the limits',
    (c) => {
      for (const d of [-90, 40, 2000, -2000]) {
        const r = resizeFromCorner(start, c, d, d, vp);
        expect(fixed(r, c)).toEqual(fixed(start, c));
        expect(r.width).toBeGreaterThanOrEqual(280);
        expect(r.height).toBeGreaterThanOrEqual(210);
        expect(r.width).toBeLessThanOrEqual(760);
        expect(r.height).toBeLessThanOrEqual(600);
        expect(Math.min(r.left, r.top)).toBeGreaterThanOrEqual(12);
        expect(r.left + r.width).toBeLessThanOrEqual(vp.width - 12);
        expect(r.top + r.height).toBeLessThanOrEqual(vp.height - 12);
      }
    }
  );
  it('steps a grip by key', () => {
    expect(resizeByKey(start, 'se', 'ArrowRight', false, vp).width).toBe(376);
    expect(resizeByKey(start, 'nw', 'ArrowUp', true, vp)).toMatchObject({
      top: 236,
      height: 334,
    });
  });
  it('clamps a size to the limits and a small viewport', () => {
    expect(clampFloatSize({ width: 1, height: 9999 }, vp)).toEqual({
      width: 280,
      height: 600,
    });
    expect(
      clampFloatSize({ width: 760, height: 600 }, { width: 500, height: 400 })
    ).toEqual({ width: 476, height: 376 });
  });
  it('reads junk as the default and round-trips a size', () => {
    for (const raw of [null, '', 'nope', '[]', '{"width":"9"}', 'null'])
      expect(readFloatSize(raw)).toEqual(FLOAT_DEFAULT_SIZE);
    const size = { width: 400, height: 300 };
    expect(readFloatSize(writeFloatSize(size))).toEqual(size);
  });
});
