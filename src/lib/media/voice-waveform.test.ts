import { describe, expect, it } from 'vitest';
import {
  MIN_PEAK,
  WAVEFORM_BARS,
  formatClock,
  levelFromTimeDomain,
  pushLevel,
  formatRate,
  nextPlaybackRate,
  peaksFromSamples,
  seededPeaks,
  seekFraction,
} from './voice-waveform';

describe('peaksFromSamples', () => {
  it('returns one bar per slot, loudest at full height', () => {
    const samples = new Float32Array(400);
    for (let i = 300; i < 400; i++) samples[i] = i % 2 ? 0.8 : -0.8;
    const peaks = peaksFromSamples(samples, 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[3]).toBeCloseTo(1);
    expect(peaks[0]).toBeCloseTo(MIN_PEAK);
  });

  it('scales by RMS relative to the loudest slice', () => {
    const samples = [0.5, -0.5, 0.25, -0.25];
    const [loud, quiet] = peaksFromSamples(samples, 2);
    expect(loud).toBeCloseTo(1);
    expect(quiet).toBeCloseTo(MIN_PEAK + (1 - MIN_PEAK) * 0.5);
  });

  it('fills every bar when there are fewer samples than bars', () => {
    const peaks = peaksFromSamples([0.2, 0.4], 6);
    expect(peaks).toHaveLength(6);
    peaks.forEach((p) => expect(p).toBeGreaterThanOrEqual(MIN_PEAK));
  });

  it('draws silence and empty input as the floor', () => {
    expect(peaksFromSamples(new Float32Array(100), 5)).toEqual(
      Array(5).fill(MIN_PEAK)
    );
    expect(peaksFromSamples([], 3)).toEqual(Array(3).fill(MIN_PEAK));
    expect(peaksFromSamples([1], 0)).toEqual([]);
  });
});

describe('seededPeaks', () => {
  it('is stable per seed and differs between seeds', () => {
    expect(seededPeaks('a')).toEqual(seededPeaks('a'));
    expect(seededPeaks('a')).not.toEqual(seededPeaks('b'));
  });

  it('stays inside [MIN_PEAK, 1]', () => {
    const peaks = seededPeaks('message-id-123');
    expect(peaks).toHaveLength(WAVEFORM_BARS);
    peaks.forEach((p) => {
      expect(p).toBeGreaterThanOrEqual(MIN_PEAK);
      expect(p).toBeLessThanOrEqual(1);
    });
  });
});

describe('formatClock', () => {
  it('formats minutes and padded seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9.9)).toBe('0:09');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(600)).toBe('10:00');
  });

  it('reads 0:00 for an unknown length', () => {
    // Chrome reports Infinity for an Ogg/Opus file with no duration header.
    expect(formatClock(Infinity)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('playback rate', () => {
  it('cycles 1 → 1.5 → 2 → 1', () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
    expect(nextPlaybackRate(3)).toBe(1);
  });

  it('labels the rate', () => {
    expect(formatRate(1.5)).toBe('1.5×');
  });
});

describe('seekFraction', () => {
  it('clamps to the box', () => {
    expect(seekFraction(150, 100, 200)).toBe(0.25);
    expect(seekFraction(50, 100, 200)).toBe(0);
    expect(seekFraction(400, 100, 200)).toBe(1);
    expect(seekFraction(150, 100, 0)).toBe(0);
  });
});

describe('live level', () => {
  it('reads silence as 0 and a full-scale square as 1', () => {
    expect(levelFromTimeDomain(new Uint8Array(64).fill(128))).toBe(0);
    const loud = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 0 : 255));
    expect(levelFromTimeDomain(loud)).toBe(1);
    expect(levelFromTimeDomain([])).toBe(0);
  });

  it('boosts quiet speech so the meter moves', () => {
    const quiet = Uint8Array.from({ length: 64 }, (_, i) =>
      i % 2 ? 128 - 13 : 128 + 13
    );
    const level = levelFromTimeDomain(quiet);
    expect(level).toBeGreaterThan(0.25);
    expect(level).toBeLessThan(0.35);
  });

  it('keeps the newest entries', () => {
    expect(pushLevel([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushLevel([], 0.5, 3)).toEqual([0.5]);
  });
});
