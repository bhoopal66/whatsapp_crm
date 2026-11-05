// Segmenter confidence to canvas alpha. Pure, so it is tested in node.

/** Weight of the new mask; the rest is the previous one (edge flicker). */
export const MASK_EMA = 0.6;
const EDGE_LOW = 0.35;
const EDGE_HIGH = 0.75;

/** Updates `smoothed` in place; `first` takes `confidence` as it is. */
export function writeMaskAlpha(
  confidence: Float32Array,
  smoothed: Float32Array,
  rgba: Uint8ClampedArray,
  first: boolean
): void {
  const k = first ? 1 : MASK_EMA;
  for (let i = 0; i < confidence.length; i++) {
    const v = smoothed[i] + k * (confidence[i] - smoothed[i]);
    smoothed[i] = v;
    const t = Math.min(1, Math.max(0, (v - EDGE_LOW) / (EDGE_HIGH - EDGE_LOW)));
    rgba[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
  }
}
