import { describe, expect, it } from 'vitest';

import {
  campaignProgress,
  scheduleDay,
  sortInFlight,
  weekCampaigns,
  weekSummary,
  type CampaignRow,
} from './campaigns';

function row(over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 'b1',
    name: 'Promo',
    status: 'scheduled',
    scheduled_at: null,
    total_recipients: 0,
    sent_count: 0,
    delivered_count: 0,
    read_count: 0,
    failed_count: 0,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

describe('campaignProgress', () => {
  it('is sent of total', () => {
    expect(campaignProgress({ sent_count: 25, total_recipients: 200 })).toEqual(
      { sent: 25, total: 200, percent: 13 }
    );
  });

  it('never divides by zero or overflows the bar', () => {
    expect(campaignProgress({ sent_count: 0, total_recipients: 0 })).toEqual({
      sent: 0,
      total: 0,
      percent: 0,
    });
    expect(
      campaignProgress({ sent_count: 12, total_recipients: 10 }).percent
    ).toBe(100);
  });
});

describe('sortInFlight', () => {
  it('puts sending first, then the soonest scheduled', () => {
    const rows = [
      row({ id: 'later', scheduled_at: '2026-10-30T09:00:00Z' }),
      row({ id: 'none' }),
      row({ id: 'soon', scheduled_at: '2026-10-29T09:00:00Z' }),
      row({ id: 'live', status: 'sending' }),
    ];
    expect(sortInFlight(rows).map((r) => r.id)).toEqual([
      'live',
      'soon',
      'later',
      'none',
    ]);
  });
});

describe('weekSummary', () => {
  it('sums the week into one line', () => {
    expect(
      weekSummary([
        row({ sent_count: 100, delivered_count: 80, read_count: 30 }),
        row({ sent_count: 50, delivered_count: 43, read_count: 17 }),
      ])
    ).toEqual({ campaigns: 2, sent: 150, deliveredPct: 82, readPct: 31 });
  });

  it('has no rates when nothing was sent', () => {
    expect(weekSummary([])).toEqual({
      campaigns: 0,
      sent: 0,
      deliveredPct: null,
      readPct: null,
    });
  });
});

describe('scheduleDay', () => {
  const now = new Date(2026, 9, 28, 10, 0);
  it('names the day', () => {
    expect(scheduleDay(new Date(2026, 9, 28, 18, 0), now)).toBe('today');
    expect(scheduleDay(new Date(2026, 9, 29, 9, 0), now)).toBe('tomorrow');
    expect(scheduleDay(new Date(2026, 9, 31, 0, 30), now)).toBe('week');
    expect(scheduleDay(new Date(2026, 10, 4, 9, 0), now)).toBe('later');
  });

  it('flags a time already passed', () => {
    expect(scheduleDay(new Date(2026, 9, 28, 9, 0), now)).toBe('past');
  });
});

describe('weekCampaigns', () => {
  const row = (status: string, sent_count: number | null) => ({
    status,
    sent_count,
  });

  it('keeps sent ones, even a fully failed one', () => {
    expect(weekCampaigns([row('sent', 0), row('sent', 5)])).toHaveLength(2);
  });

  it('keeps a stopped campaign only when it sent something', () => {
    const out = weekCampaigns([
      row('stopped', 12),
      row('stopped', 0),
      row('stopped', null),
    ]);
    expect(out).toEqual([row('stopped', 12)]);
  });

  it('ignores any other status', () => {
    expect(weekCampaigns([row('draft', 3)])).toEqual([]);
  });
});
