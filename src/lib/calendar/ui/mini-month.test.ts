import { describe, expect, it } from 'vitest';

import { addMonths, markedDays, monthGrid } from './mini-month';
import { aTask, anEvent } from './test-items';

describe('monthGrid', () => {
  it('lays October 2026 out in six Monday-first weeks', () => {
    const g = monthGrid(2026, 9, 1);
    expect(g).toHaveLength(6);
    expect(g.every((w) => w.length === 7)).toBe(true);
    // 1 Oct 2026 is a Thursday.
    expect(g[0][0]).toEqual({ key: '2026-09-28', day: 28, inMonth: false });
    expect(g[0][3]).toEqual({ key: '2026-10-01', day: 1, inMonth: true });
    expect(g[4][5]).toEqual({ key: '2026-10-31', day: 31, inMonth: true });
  });

  it('honours a Sunday start', () => {
    expect(monthGrid(2026, 9, 0)[0][0].key).toBe('2026-09-27');
  });
});

describe('addMonths', () => {
  it('crosses years both ways', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
  });
});

describe('markedDays', () => {
  it('marks timed items by the zone date', () => {
    // 21:30Z on the 15th is the 16th in Dubai.
    const late = anEvent({
      start: '2026-10-15T21:30:00Z',
      end: '2026-10-15T22:00:00Z',
    });
    expect([...markedDays([late], 'Asia/Dubai')]).toEqual(['2026-10-16']);
    expect([...markedDays([late], 'UTC')]).toEqual(['2026-10-15']);
  });

  it('marks each day of an all-day span, end exclusive', () => {
    const span = aTask({ start: '2026-10-30', end: '2026-11-02' });
    expect([...markedDays([span], 'UTC')]).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('does not mark the next day for an item ending at midnight', () => {
    const ev = anEvent({
      start: '2026-10-15T19:00:00Z',
      end: '2026-10-15T20:00:00Z',
    });
    expect([...markedDays([ev], 'Asia/Dubai')]).toEqual(['2026-10-15']);
  });
});
