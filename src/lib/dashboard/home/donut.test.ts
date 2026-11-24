import { describe, expect, it } from 'vitest';

import type { PipelineStageSlice } from '@/lib/dashboard/types';
import { donutShares, isMixed } from './donut';

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
