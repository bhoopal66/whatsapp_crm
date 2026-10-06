import { describe, expect, it } from 'vitest';
import {
  foldMessageSeries,
  foldPipelineSlices,
  foldResponseTime,
  sumOpenDeals,
} from './aggregate';

describe('foldMessageSeries', () => {
  it('seeds zero days and drops days outside the window', () => {
    const out = foldMessageSeries(
      ['2026-09-22', '2026-09-23', '2026-09-24'],
      [
        { day: '2026-09-21', incoming: 9, outgoing: 9 },
        { day: '2026-09-23', incoming: '3', outgoing: 2 },
      ]
    );
    expect(out).toEqual([
      { day: '2026-09-22', incoming: 0, outgoing: 0 },
      { day: '2026-09-23', incoming: 3, outgoing: 2 },
      { day: '2026-09-24', incoming: 0, outgoing: 0 },
    ]);
  });
});

describe('foldResponseTime', () => {
  it('averages per weekday across all periods and per week separately', () => {
    const out = foldResponseTime([
      { dow: 0, period: 'this_week', samples: 2, total_minutes: 10 },
      { dow: 0, period: 'last_week', samples: 1, total_minutes: 20 },
      { dow: 3, period: 'earlier', samples: '4', total_minutes: '8' },
    ]);
    expect(out.buckets[0]).toEqual({ dow: 0, avgMinutes: 10, samples: 3 });
    expect(out.buckets[3]).toEqual({ dow: 3, avgMinutes: 2, samples: 4 });
    expect(out.buckets[1]).toEqual({ dow: 1, avgMinutes: null, samples: 0 });
    expect(out.buckets).toHaveLength(7);
    expect(out.thisWeekAvg).toBe(5);
    expect(out.lastWeekAvg).toBe(20);
  });

  it('returns nulls with no samples', () => {
    const out = foldResponseTime([]);
    expect(out.thisWeekAvg).toBeNull();
    expect(out.lastWeekAvg).toBeNull();
    expect(out.buckets.every((b) => b.avgMinutes === null)).toBe(true);
  });
});

describe('open deals', () => {
  const rows = [
    { stage_id: 's1', deal_count: 2, total_value: '150.50' },
    { stage_id: 's3', deal_count: '1', total_value: 0 },
    { stage_id: 'gone', deal_count: 1, total_value: 10 },
  ];

  it('sums every stage for the metric card', () => {
    expect(sumOpenDeals(rows)).toEqual({ count: 4, value: 160.5 });
  });

  it('keeps stage order, defaults colour, hides empty stages', () => {
    const slices = foldPipelineSlices(
      [
        { id: 's1', name: 'Lead', color: '' },
        { id: 's2', name: 'Won', color: '#fff' },
        { id: 's3', name: 'Demo', color: '#000' },
      ],
      rows
    );
    expect(slices).toEqual([
      {
        id: 's1',
        name: 'Lead',
        color: '#64748b',
        dealCount: 2,
        totalValue: 150.5,
      },
      { id: 's3', name: 'Demo', color: '#000', dealCount: 1, totalValue: 0 },
    ]);
  });
});
