import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CALL_REPORT_MAX_DAYS,
  CALL_REPORT_OUTCOMES,
  CALL_REPORT_PERIODS,
  CALL_STATS_PERIODS,
  averageSeconds,
  callReportRange,
  checkCustomDays,
  formatDuration,
  hasCalls,
  isCallReportPeriod,
  isCallStatsPeriod,
  outcomeCounts,
  parseCallReport,
  reportTimeZone,
  zonedMidnight,
} from './call-report';
import { DISPOSITIONS } from './calls';

const DUBAI = 'Asia/Dubai';
const iso = (d: Date) => d.toISOString();
const range = (...args: Parameters<typeof callReportRange>) => {
  const r = callReportRange(...args);
  if (!r.ok) throw new Error(`refused: ${r.problem}`);
  return { from: iso(r.from), to: iso(r.to) };
};

describe('periods and zones', () => {
  it('knows its periods', () => {
    expect(isCallReportPeriod('week')).toBe(true);
    expect(isCallReportPeriod('7d')).toBe(false);
    expect(isCallReportPeriod(undefined)).toBe(false);
  });

  it("the report page's periods add the ones just gone; the tab's stay as they are", () => {
    expect(CALL_REPORT_PERIODS).toEqual(['today', 'week', 'month', 'custom']);
    for (const p of CALL_REPORT_PERIODS)
      expect(isCallStatsPeriod(p)).toBe(true);
    for (const p of ['yesterday', 'last_week', 'last_month']) {
      expect(isCallStatsPeriod(p)).toBe(true);
      expect(isCallReportPeriod(p)).toBe(false);
    }
    expect(CALL_STATS_PERIODS).toHaveLength(7);
    expect(isCallStatsPeriod('year')).toBe(false);
    expect(isCallStatsPeriod(null)).toBe(false);
  });

  it("takes the account's zone, else the viewer's, else the UAE's", () => {
    expect(reportTimeZone('Europe/London', 'Asia/Seoul')).toBe('Europe/London');
    expect(reportTimeZone('Not/AZone', 'Asia/Seoul')).toBe('Asia/Seoul');
    expect(reportTimeZone(null, 'nonsense')).toBe(DUBAI);
    expect(reportTimeZone(undefined, null)).toBe(DUBAI);
  });
});

describe('callReportRange', () => {
  // Tuesday 13 October 2026, 14:00 in Dubai (UTC+4).
  const now = new Date('2026-10-13T10:00:00Z');

  it('today runs from local midnight to now', () => {
    expect(range('today', now, DUBAI)).toEqual({
      from: '2026-10-12T20:00:00.000Z',
      to: '2026-10-13T10:00:00.000Z',
    });
  });

  it('a week starts on Monday, also seen from a Sunday', () => {
    expect(range('week', now, DUBAI).from).toBe('2026-10-11T20:00:00.000Z');
    const sunday = new Date('2026-10-18T15:00:00Z');
    expect(range('week', sunday, DUBAI).from).toBe('2026-10-11T20:00:00.000Z');
    const monday = new Date('2026-10-12T08:00:00Z');
    expect(range('week', monday, DUBAI).from).toBe('2026-10-11T20:00:00.000Z');
  });

  it("the month is the zone's month, not UTC's", () => {
    expect(range('month', now, DUBAI).from).toBe('2026-09-30T20:00:00.000Z');
    // 21:00 UTC on 31 October is already 1 November in Dubai.
    const late = new Date('2026-10-31T21:00:00Z');
    expect(range('month', late, DUBAI).from).toBe('2026-10-31T20:00:00.000Z');
  });

  it('never ends where it starts (a request at midnight)', () => {
    const midnight = new Date('2026-10-12T20:00:00Z');
    expect(range('today', midnight, DUBAI)).toEqual({
      from: '2026-10-12T20:00:00.000Z',
      to: '2026-10-12T20:00:01.000Z',
    });
  });

  it('a custom period is whole local days, both inclusive', () => {
    expect(
      range('custom', now, DUBAI, { from: '2026-10-01', to: '2026-10-03' })
    ).toEqual({
      from: '2026-09-30T20:00:00.000Z',
      to: '2026-10-03T20:00:00.000Z',
    });
    // Across a month end.
    expect(
      range('custom', now, DUBAI, { from: '2026-09-30', to: '2026-09-30' })
    ).toEqual({
      from: '2026-09-29T20:00:00.000Z',
      to: '2026-09-30T20:00:00.000Z',
    });
  });

  it('keeps local midnight across a DST change', () => {
    // New York springs forward on 8 March 2026: a 23-hour day.
    expect(
      range('custom', now, 'America/New_York', {
        from: '2026-03-08',
        to: '2026-03-08',
      })
    ).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
    expect(iso(zonedMidnight(2026, 11, 1, 'America/New_York'))).toBe(
      '2026-11-01T04:00:00.000Z'
    );
  });

  it('yesterday is the whole local day before today', () => {
    expect(range('yesterday', now, DUBAI)).toEqual({
      from: '2026-10-11T20:00:00.000Z',
      to: '2026-10-12T20:00:00.000Z',
    });
    // 21:00 UTC on 12 October is already the 13th in Dubai.
    expect(range('yesterday', new Date('2026-10-12T21:00:00Z'), DUBAI)).toEqual(
      range('yesterday', now, DUBAI)
    );
  });

  it('last week runs Monday to Monday, seen from any day of this week', () => {
    const lastWeek = {
      from: '2026-10-04T20:00:00.000Z',
      to: '2026-10-11T20:00:00.000Z',
    };
    expect(range('last_week', now, DUBAI)).toEqual(lastWeek);
    const monday = new Date('2026-10-12T08:00:00Z');
    expect(range('last_week', monday, DUBAI)).toEqual(lastWeek);
    const sunday = new Date('2026-10-18T15:00:00Z');
    expect(range('last_week', sunday, DUBAI)).toEqual(lastWeek);
  });

  it("last month is the zone's whole month before this one, also in January", () => {
    expect(range('last_month', now, DUBAI)).toEqual({
      from: '2026-08-31T20:00:00.000Z',
      to: '2026-09-30T20:00:00.000Z',
    });
    const december = {
      from: '2026-11-30T20:00:00.000Z',
      to: '2026-12-31T20:00:00.000Z',
    };
    expect(
      range('last_month', new Date('2027-01-15T08:00:00Z'), DUBAI)
    ).toEqual(december);
    // 21:00 UTC on 31 December is already January in Dubai.
    expect(
      range('last_month', new Date('2026-12-31T21:00:00Z'), DUBAI)
    ).toEqual(december);
  });

  it('the periods just gone keep local midnight across a DST change', () => {
    const ny = 'America/New_York';
    // Monday 9 March 2026, noon in New York, the day after springing forward.
    const monday = new Date('2026-03-09T16:00:00Z');
    expect(range('yesterday', monday, ny)).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
    expect(range('last_week', monday, ny)).toEqual({
      from: '2026-03-02T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
    expect(range('last_month', new Date('2026-04-10T16:00:00Z'), ny)).toEqual({
      from: '2026-03-01T05:00:00.000Z',
      to: '2026-04-01T04:00:00.000Z',
    });
  });

  it('refuses a custom period that is missing, reversed or too long', () => {
    const refused = (from?: string, to?: string) => {
      const r = callReportRange('custom', now, DUBAI, { from, to });
      return r.ok ? 'ok' : r.problem;
    };
    expect(refused()).toBe('missing');
    expect(refused('2026-10-01')).toBe('missing');
    expect(refused('2026-02-30', '2026-03-01')).toBe('missing');
    expect(refused('1 Oct', '2026-10-02')).toBe('missing');
    expect(refused('2026-10-03', '2026-10-01')).toBe('order');
    expect(CALL_REPORT_MAX_DAYS).toBe(92);
    expect(checkCustomDays('2026-01-01', '2026-04-02')).toBeNull(); // 92 days
    expect(checkCustomDays('2026-01-01', '2026-04-03')).toBe('span'); // 93
  });
});

describe('parseCallReport', () => {
  const outcomes = {
    interested: 1,
    docs_requested: 0,
    call_back: 1,
    not_eligible: 0,
    wrong_number: 0,
    none: 1,
  };
  const rows = [
    {
      row_kind: 'person',
      user_id: 'u-1',
      full_name: '  Sara  ',
      extension: '101',
      inbound_answered: 2,
      outbound: 2,
      missed: 1,
      talk_seconds: 180,
      talk_calls: 3,
      ring_seconds: 30,
      ring_calls: 2,
      outcomes,
    },
    {
      row_kind: 'person',
      user_id: 'u-2',
      full_name: '',
      extension: null,
      inbound_answered: '1',
      outbound: 0,
      missed: 0,
      talk_seconds: '60',
      talk_calls: 1,
      ring_seconds: 6,
      ring_calls: 1,
      outcomes: { wrong_number: 1 },
    },
    { row_kind: 'none', user_id: null, missed: 1, outcomes: {} },
    {
      row_kind: 'total',
      user_id: null,
      inbound_answered: 3,
      outbound: 2,
      missed: 2,
      talk_seconds: 240,
      talk_calls: 4,
      ring_seconds: 36,
      ring_calls: 3,
      outcomes: { ...outcomes, wrong_number: 1 },
    },
  ];

  it('splits people, calls with no person and the total', () => {
    const r = parseCallReport(rows);
    expect(r.people.map((p) => [p.userId, p.name, p.extension])).toEqual([
      ['u-1', 'Sara', '101'],
      ['u-2', null, null],
    ]);
    expect(r.people[1]).toMatchObject({
      inboundAnswered: 1,
      talkSeconds: 60,
      outcomes: { wrong_number: 1, interested: 0, none: 0 },
    });
    expect(r.unattributed).toMatchObject({ missed: 1, inboundAnswered: 0 });
    expect(r.total).toMatchObject({ inboundAnswered: 3, talkCalls: 4 });
  });

  it('reads anything else as nothing', () => {
    const empty = parseCallReport('nope');
    expect(empty.people).toEqual([]);
    expect(hasCalls(empty.total)).toBe(false);
    const odd = parseCallReport([
      null,
      { row_kind: 'person' },
      { row_kind: 'total', missed: -3, outbound: 'x', outcomes: 'bad' },
    ]);
    expect(odd.people).toEqual([]);
    expect(odd.total.missed).toBe(0);
    expect(odd.total.outbound).toBe(0);
    expect(odd.total.outcomes.none).toBe(0);
  });
});

describe('what the tab shows', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(725)).toBe('12:05');
    expect(formatDuration(3729)).toBe('1:02:09');
    expect(formatDuration(null)).toBe('—');
  });

  it('averages only over calls that carry a figure', () => {
    expect(averageSeconds(100, 0)).toBeNull();
    expect(averageSeconds(100, 3)).toBe(33);
  });

  it('lists non-zero outcomes in a fixed order; an outcome alone is a call', () => {
    const f = parseCallReport([
      { row_kind: 'total', outcomes: { none: 2, call_back: 1 } },
    ]).total;
    expect(outcomeCounts(f)).toEqual([
      { outcome: 'call_back', count: 1 },
      { outcome: 'none', count: 2 },
    ]);
    expect(hasCalls(f)).toBe(true);
  });
});

describe('agrees with the database', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/098_pbx_call_report.sql'),
    'utf8'
  );

  it('the outcomes are the dispositions plus none, as 098 builds them', () => {
    expect(CALL_REPORT_OUTCOMES).toEqual([...DISPOSITIONS, 'none']);
    const built = [...sql.matchAll(/^\s+'([a-z_]+)',\s+count\(\*\)/gm)].map(
      (m) => m[1]
    );
    expect(built).toEqual([...CALL_REPORT_OUTCOMES]);
  });

  it("a custom period fits 098's 100 days, with a day of slack for DST", () => {
    expect(sql).toContain("p_to - p_from > interval '100 days'");
    expect(CALL_REPORT_MAX_DAYS + 1).toBeLessThan(100);
  });
});
