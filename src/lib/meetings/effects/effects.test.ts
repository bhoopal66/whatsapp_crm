import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GIVE_UP_AFTER_MS,
  REDUCED_FPS,
  TARGET_FPS,
  initialBudget,
  stepBudget,
  type BudgetState,
} from './frame-budget';
import { writeMaskAlpha } from './mask';
import {
  MAX_CUSTOM_IMAGE_BYTES,
  isBackgroundEffect,
  parseEffectPref,
  serializeEffectPref,
} from './prefs';
import { createTicker } from './ticker';
import { isBackdropPreset } from './types';

function feed(s0: BudgetState, ms: number, from: number, to: number) {
  let last = { state: s0, fps: s0.fps, giveUp: false };
  for (let t = from; t <= to; t += 40) last = stepBudget(last.state, ms, t);
  return last;
}

describe('stepBudget', () => {
  it('holds the target on a cheap frame', () => {
    expect(feed(initialBudget(), 12, 0, 20000).fps).toBe(TARGET_FPS);
  });
  it('drops on the rolling cost, not on one spike', () => {
    const calm = feed(initialBudget(), 10, 0, 1000).state;
    expect(stepBudget(calm, 75, 1040).fps).toBe(TARGET_FPS);
    expect(feed(calm, 50, 1040, 2000).fps).toBe(REDUCED_FPS);
  });
  it('recovers only after staying calm, never between the lines', () => {
    const hot = feed(initialBudget(), 50, 0, 1000).state;
    expect(feed(hot, 30, 1040, 9000).fps).toBe(REDUCED_FPS);
    expect(feed(hot, 10, 1040, 2000).fps).toBe(REDUCED_FPS);
    expect(feed(hot, 10, 1040, 5000).fps).toBe(TARGET_FPS);
  });
  it('gives up after sustained overload only', () => {
    const over = (to: number) => feed(initialBudget(), 120, 0, to);
    expect(over(GIVE_UP_AFTER_MS - 100).giveUp).toBe(false);
    expect(over(GIVE_UP_AFTER_MS + 100).giveUp).toBe(true);
    const eased = feed(over(5000).state, 5, 5040, 6000).state;
    expect(eased.overSince).toBeNull();
    expect(feed(eased, 120, 6040, 9000).giveUp).toBe(false);
  });
});

describe('prefs', () => {
  it('round-trips every kind', () => {
    for (const e of [
      { kind: 'none' },
      { kind: 'blur', strength: 'strong' },
      { kind: 'color', preset: 'sand' },
      { kind: 'image', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' },
    ] as const) {
      expect(parseEffectPref(serializeEffectPref(e))).toEqual(e);
    }
  });
  it('reads junk as none', () => {
    for (const raw of [
      null,
      '',
      '{',
      'null',
      '{"kind":"blur"}',
      '{"kind":"color","preset":"neon"}',
      '{"kind":"image","dataUrl":"data:text/html;base64,AAAA"}',
      '{"kind":"image","dataUrl":"https://x.test/a.jpg"}',
    ]) {
      expect(parseEffectPref(raw)).toEqual({ kind: 'none' });
    }
  });
  it('refuses an image over the limit, both ways', () => {
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(MAX_CUSTOM_IMAGE_BYTES)}`;
    const big = { kind: 'image', dataUrl } as const;
    expect(isBackgroundEffect(big)).toBe(false);
    expect(serializeEffectPref(big)).toBeNull();
    expect(parseEffectPref(JSON.stringify(big))).toEqual({ kind: 'none' });
  });
  it('knows its presets', () => {
    expect(isBackdropPreset('mist')).toBe(true);
    expect(isBackdropPreset('logo')).toBe(false);
  });
});

it('writeMaskAlpha thresholds softly and smooths against the last mask', () => {
  const smoothed = new Float32Array(3);
  const rgba = new Uint8ClampedArray(12);
  writeMaskAlpha(new Float32Array([0, 0.55, 1]), smoothed, rgba, true);
  expect([rgba[3], rgba[7], rgba[11]]).toEqual([0, 128, 255]);
  writeMaskAlpha(new Float32Array([1, 0.55, 0]), smoothed, rgba, false);
  expect(smoothed[0]).toBeCloseTo(0.6);
  expect(smoothed[2]).toBeCloseTo(0.4);
});

describe('createTicker', () => {
  afterEach(() => vi.useRealTimers());
  it('falls back to a plain timer when no worker can start', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const t = createTicker(onTick, 10); // node: Worker is undefined
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(10);
    t.setFps(20);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(30);
    t.stop();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(30);
  });
});
