import { currencyTotals } from '@/lib/currency-totals';
import type { PipelineStageSlice } from '@/lib/dashboard/types';

// ------------------------------------------------------------
// The geometry of the home pipeline ring. Pure.
// ------------------------------------------------------------

export interface DonutSegment {
  id: string;
  color: string;
  /** An SVG arc. */
  path: string;
}

/** Below this a stage is a sliver that disappears into the stroke. */
const MIN_SHARE = 0.02;

/**
 * Each stage's share of the ring, in stage order: of the value, or, since
 * amounts in different currencies cannot be compared, of the deal count
 * when there is more than one. Floored for drawing only; the legend
 * carries the real totals.
 */
export function donutShares(
  stages: readonly PipelineStageSlice[],
  mixed: boolean
): number[] {
  const weights = stages.map((s) =>
    mixed ? s.dealCount : s.totals.reduce((sum, t) => sum + t.value, 0)
  );
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const floored = weights.map((w) => Math.max(w / total, MIN_SHARE));
  const sum = floored.reduce((a, b) => a + b, 0);
  return floored.map((x) => x / sum);
}

/** Whether the stages hold amounts in more than one currency. */
export function isMixed(
  stages: readonly PipelineStageSlice[],
  defaultCurrency: string
): boolean {
  return (
    currencyTotals(
      stages.flatMap((s) => s.totals),
      defaultCurrency
    ).length > 1
  );
}

export function donutSegments(
  stages: readonly PipelineStageSlice[],
  mixed: boolean,
  cx: number,
  cy: number,
  r: number
): DonutSegment[] {
  let offset = 0;
  return donutShares(stages, mixed).map((share, i) => {
    const start = offset;
    offset += share;
    return {
      id: stages[i].id,
      color: stages[i].color,
      path: arcPath(cx, cy, r, angle(start), angle(offset)),
    };
  });
}

/** Share of the circle → radians, from the top. */
function angle(share: number): number {
  return share * Math.PI * 2 - Math.PI / 2;
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startRad: number,
  endRad: number
): string {
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const largeArc = endRad - startRad > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}
