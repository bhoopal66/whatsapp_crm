import type { TrendPoint } from './trends';

/**
 * The insights card's trend lines (docs/jev-insights.md, "Customer
 * insights"): the values of one scale from the history series, and the
 * SVG path that draws them. Pure and dependency-free (a type import
 * only) because the card is a client component.
 */

/** Fewer values than this and the card says there is not enough history
 *  yet. Equal to trends.ts's TREND_MIN_POINTS, so a line and its trend
 *  word appear together. */
export const SPARKLINE_MIN_POINTS = 4;

/** Each scale's maximum: sentiment is 0..4, lead temperature 0..3. */
export const SPARKLINE_MAX = { sentiment: 4, leadTemp: 3 } as const;

export type SparklineScale = keyof typeof SPARKLINE_MAX;

/** The known values of one scale, oldest first (a point without one is
 *  skipped, not drawn as zero). */
export function sparklineValues(
  series: readonly TrendPoint[],
  scale: SparklineScale
): number[] {
  return series.flatMap((p) => {
    const v = p[scale];
    return typeof v === 'number' && Number.isFinite(v) ? [v] : [];
  });
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * An SVG path through `values` in a `width` × `height` box: evenly
 * spaced left to right, 0 at the bottom and `max` at the top, each value
 * clamped to 0..max, `pad` units kept clear on every side so the stroke
 * is not clipped. Null with fewer than two values (nothing to draw).
 */
export function sparklinePath(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
  pad = 1
): string | null {
  if (values.length < 2 || !(max > 0)) return null;
  const w = width - 2 * pad;
  const h = height - 2 * pad;
  const step = w / (values.length - 1);
  return values
    .map((v, i) => {
      const c = Math.min(Math.max(v, 0), max);
      const x = r1(pad + i * step);
      const y = r1(pad + h - (c / max) * h);
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}
