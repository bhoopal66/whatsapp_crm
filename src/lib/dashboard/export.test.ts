import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_HEADER,
  MESSAGES_DAYS,
  dashboardCsv,
  dashboardRows,
  dashboardWindows,
  zonedDayKey,
  zonedMondayIndex,
  type DashboardFigures,
} from './export';

describe('zoned helpers', () => {
  // 2026-10-01 is a Thursday; 21:30 UTC is already Friday in Dubai.
  const now = new Date('2026-10-01T21:30:00Z');

  it('reads the day and weekday in the zone', () => {
    expect(zonedDayKey(now, 'UTC')).toBe('2026-10-01');
    expect(zonedDayKey(now, 'Asia/Dubai')).toBe('2026-10-02');
    expect(zonedMondayIndex(now, 'UTC')).toBe(3);
    expect(zonedMondayIndex(now, 'Asia/Dubai')).toBe(4);
  });

  it('computes the home windows in the zone', () => {
    const w = dashboardWindows(now, 'Asia/Dubai');
    expect(w.messageDays).toHaveLength(MESSAGES_DAYS);
    expect(w.messageDays[MESSAGES_DAYS - 1]).toBe('2026-10-02');
    expect(w.messageDays[0]).toBe('2026-09-03');
    // Dubai midnight is 20:00 UTC the day before.
    expect(w.messagesSince.toISOString()).toBe('2026-09-02T20:00:00.000Z');
    expect(w.thisWeekStart.toISOString()).toBe('2026-09-27T20:00:00.000Z');
    expect(w.lastWeekStart.toISOString()).toBe('2026-09-20T20:00:00.000Z');
    // 13 days before Friday 2 October, Dubai: Saturday 19 September.
    expect(w.responseSince.toISOString()).toBe('2026-09-18T20:00:00.000Z');
  });
});

const FIGURES: DashboardFigures = {
  tz: 'UTC',
  today: '2026-10-01',
  messages: [
    { day: '2026-09-30', incoming: 4, outgoing: 6 },
    { day: '2026-10-01', incoming: 1, outgoing: 2 },
  ],
  responseTime: {
    buckets: [{ dow: 0, avgMinutes: 12.345, samples: 3 }],
    thisWeekAvg: 10,
    lastWeekAvg: null,
  },
  pipeline: [
    {
      id: 's1',
      name: '=Qualified',
      color: '#000',
      dealCount: 2,
      totals: [{ currency: 'AED', value: 500 }],
    },
    {
      id: 's2',
      name: 'Won',
      color: '#000',
      dealCount: 1,
      totals: [{ currency: 'AED', value: 100 }],
    },
  ],
  campaigns: {
    week: { campaigns: 2, sent: 100, deliveredPct: 90, readPct: 40 },
    inFlight: 1,
  },
  numbers: { total: 3, connected: 2, disconnected: 1, unknown: 0 },
  team: {
    todayNew: 7,
    reply: { replied: 4, total: 5, percent: 80, aimPercent: 30, tone: 'good' },
    pending: 2,
    waitingRecent: 3,
    waitingUnassignedRecent: 1,
  },
};

describe('dashboardRows', () => {
  const rows = dashboardRows(FIGURES);
  const find = (section: string, metric: string, period?: string) =>
    rows.find(
      (r) =>
        r[0] === section &&
        r[1] === metric &&
        (period === undefined || r[2] === period)
    )?.[3];

  it('has four cells per row', () => {
    for (const r of rows) expect(r).toHaveLength(DASHBOARD_HEADER.length);
  });

  it('totals the messages window and lists each day', () => {
    expect(
      find(
        'Messages',
        'Incoming messages',
        'Last 2 days (2026-09-30 to 2026-10-01)'
      )
    ).toBe(5);
    expect(find('Messages', 'Outgoing messages', '2026-09-30')).toBe(6);
  });

  it('sums open deals and keeps each stage', () => {
    expect(find('Pipeline (open deals)', 'Open deals')).toBe(3);
    expect(find('Pipeline (open deals)', 'Open deal value')).toBe(600);
    expect(find('Pipeline (open deals)', 'Deals in Won')).toBe(1);
  });

  it('never adds two currencies', () => {
    const mixed = dashboardRows({
      ...FIGURES,
      pipeline: [
        {
          ...FIGURES.pipeline[0],
          totals: [
            { currency: 'USD', value: 100000 },
            { currency: 'AED', value: 150000 },
          ],
        },
        {
          ...FIGURES.pipeline[1],
          totals: [{ currency: 'AED', value: 50000 }],
        },
      ],
    });
    const value = (metric: string) => mixed.find((r) => r[1] === metric)?.[3];
    expect(value('Open deal value')).toBe('AED 200,000 + USD 100,000');
    expect(value('Value in =Qualified')).toBe('AED 150,000 + USD 100,000');
    expect(value('Value in Won')).toBe(50000);
  });

  it('rounds response times and keeps no-sample weeks blank', () => {
    const s = 'First response time (minutes)';
    expect(find(s, 'Average', 'This week')).toBe(10);
    expect(find(s, 'Average', 'Last week')).toBeNull();
    expect(find(s, 'Average on Mon')).toBe(12.3);
  });

  it('carries the team, numbers and campaigns figures', () => {
    expect(find('Team activity', 'New chats started')).toBe(7);
    expect(find('Team activity', 'Reply rate %')).toBe(80);
    expect(find('WhatsApp numbers', 'Disconnected')).toBe(1);
    expect(find('Campaigns', 'Sending or scheduled')).toBe(1);
    expect(find('Campaigns', 'Delivered %')).toBe(90);
  });

  it('leaves the team section out when it could not be read', () => {
    const without = dashboardRows({ ...FIGURES, team: null });
    expect(without.some((r) => r[0] === 'Team activity')).toBe(false);
  });
});

describe('dashboardCsv', () => {
  it('writes the header and keeps a stage name inside its metric', () => {
    const csv = dashboardCsv(FIGURES);
    expect(csv.startsWith('﻿"Section","Metric","Period","Value"\r\n')).toBe(
      true
    );
    expect(csv).toContain(`"Deals in =Qualified"`);
  });
});
