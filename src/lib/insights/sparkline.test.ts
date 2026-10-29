import { describe, expect, it } from 'vitest';

import {
  SPARKLINE_MAX,
  SPARKLINE_MIN_POINTS,
  sparklinePath,
  sparklineValues,
} from './sparkline';
import { TREND_MIN_POINTS, type TrendPoint } from './trends';

describe('sparklineValues', () => {
  it('keeps one scale, oldest first, skipping unknown values', () => {
    const series: TrendPoint[] = [
      { at: 'a', sentiment: 1, leadTemp: null },
      { at: 'b', sentiment: null, leadTemp: 2 },
      { at: 'c', sentiment: 3, leadTemp: 2.5 },
    ];
    expect(sparklineValues(series, 'sentiment')).toEqual([1, 3]);
    expect(sparklineValues(series, 'leadTemp')).toEqual([2, 2.5]);
  });

  it('shows a line exactly when there is a trend', () => {
    expect(SPARKLINE_MIN_POINTS).toBe(TREND_MIN_POINTS);
    expect(SPARKLINE_MAX).toEqual({ sentiment: 4, leadTemp: 3 });
  });
});

describe('sparklinePath', () => {
  it('spaces points evenly with 0 at the bottom and max at the top', () => {
    expect(sparklinePath([0, 2, 4], 4, 42, 12, 1)).toBe('M1 11 L21 6 L41 1');
  });

  it('clamps values outside the scale', () => {
    expect(sparklinePath([-1, 9], 3, 12, 12, 0)).toBe('M0 12 L12 0');
  });

  it('rounds to one decimal', () => {
    expect(sparklinePath([0, 1, 2], 3, 10, 10, 0)).toBe('M0 10 L5 6.7 L10 3.3');
  });

  it('draws nothing with fewer than two values or no scale', () => {
    expect(sparklinePath([], 4, 40, 12)).toBeNull();
    expect(sparklinePath([2], 4, 40, 12)).toBeNull();
    expect(sparklinePath([1, 2], 0, 40, 12)).toBeNull();
  });
});
