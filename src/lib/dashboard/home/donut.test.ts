import { describe, expect, it } from 'vitest';

import type { PipelineStageSlice } from '@/lib/dashboard/types';
import { donutSegments, donutShares, isMixed } from './donut';

const stage = (
  id: string,
  dealCount: number,
  ...totals: [string, number][]
): PipelineStageSlice => ({
  id,
  name: id,
  color: '#111',
  dealCount,
  totals: totals.map(([currency, value]) => ({ currency, value })),
});

describe('donutShares', () => {
  it('are of the value in one currency', () => {
    const stages = [stage('a', 9, ['AED', 300]), stage('b', 1, ['AED', 100])];
    expect(isMixed(stages, 'AED')).toBe(false);
    expect(donutShares(stages, false)).toEqual([0.75, 0.25]);
  });

  it('are of the deal count in several', () => {
    const stages = [stage('a', 1, ['AED', 300]), stage('b', 3, ['USD', 100])];
    expect(isMixed(stages, 'AED')).toBe(true);
    expect(donutShares(stages, true)).toEqual([0.25, 0.75]);
  });

  it('a currency that amounts to nothing is not another currency', () => {
    expect(isMixed([stage('a', 2, ['AED', 300], ['USD', 0])], 'AED')).toBe(
      false
    );
  });
});

describe('donutSegments', () => {
  it('marks a stage holding every deal as the full ring, with no arc to draw', () => {
    const [only] = donutSegments(
      [stage('a', 4, ['AED', 300])],
      false,
      100,
      100,
      80
    );
    expect(only.full).toBe(true);
    expect(only.path).toBe('');
  });

  it('draws an arc for each stage when the ring is shared', () => {
    const segs = donutSegments(
      [stage('a', 9, ['AED', 300]), stage('b', 1, ['AED', 100])],
      false,
      100,
      100,
      80
    );
    expect(segs.map((s) => s.full)).toEqual([false, false]);
    expect(segs[0].path).toMatch(/^M .* A 80 80 0 /);
  });
});
