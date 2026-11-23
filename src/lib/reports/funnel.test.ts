import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEAD_SOURCES } from '@/lib/contacts/lead-source';

import {
  FUNNEL_LEAD_SOURCES,
  FUNNEL_METRICS,
  conversionSteps,
  fillFunnelDays,
  funnelCsvRows,
  funnelQueryString,
  parseFunnelFilters,
  parseFunnelReport,
  percentOf,
  zonedDay,
  type FunnelCsvLabels,
} from './funnel';

const UUID = '0b5c2a7e-1d2f-4c3b-9a8e-7f6d5c4b3a21';

const labels: FunnelCsvLabels = {
  breakdown: 'Breakdown',
  item: 'Item',
  metrics: Object.fromEntries(FUNNEL_METRICS.map((m) => [m, m])) as never,
  sections: {
    total: 'Total',
    ofPrevious: '% prev',
    ofNewChats: '% new',
    source: 'Source',
    agent: 'Agent',
    number: 'Number',
    bank: 'Bank',
  },
  all: 'All',
  unassigned: 'Unassigned',
  noNumber: 'No number',
  noBank: 'No bank',
  unnamed: 'Unnamed',
  source: (k) => `src:${k}`,
};

describe('parseFunnelReport', () => {
  it.each([null, undefined, 42, 'x', [], true])(
    'turns %p into an empty report',
    (raw) => {
      const r = parseFunnelReport(raw);
      expect(r.totals.new_chats).toBe(0);
      expect(r.totals.withdrawn).toBe(0);
      expect(r.bySource).toEqual([]);
      expect(r.byBank).toEqual([]);
      expect(r.daily).toEqual([]);
      expect(r.options).toEqual({ agents: [], numbers: [], banks: [] });
      expect(r.interestedTagId).toBeNull();
      expect(r.tagHistory).toBe(false);
    }
  );

  it('coerces junk counts to whole non-negative numbers', () => {
    const r = parseFunnelReport({
      totals: {
        new_chats: '12',
        interested: -3,
        case_opened: 'abc',
        submitted: 2.7,
        approved: Infinity,
        declined: null,
      },
    });
    expect(r.totals).toEqual({
      new_chats: 12,
      interested: 0,
      case_opened: 0,
      submitted: 2,
      approved: 0,
      declined: 0,
      withdrawn: 0,
    });
  });

  it('reads breakdowns, days and options, dropping junk', () => {
    const r = parseFunnelReport({
      interested_tag_id: UUID,
      tag_history: true,
      by_source: [
        { key: 'ad', new_chats: 5, interested: 2 },
        'junk',
        null,
        { key: null, new_chats: 1 },
      ],
      by_agent: [{ key: UUID, name: 'Sara', new_chats: 3 }],
      by_bank: [{ key: 'ADCB', name: 'ADCB', case_opened: 2, new_chats: 9 }],
      daily: [
        { day: '2026-11-02', new_chats: 1 },
        { day: 'yesterday', new_chats: 9 },
        { day: '2026-11-01', new_chats: 2, interested: 1, case_opened: 1 },
      ],
      options: {
        agents: [{ id: UUID, name: 'Sara' }, { id: UUID }, { name: 'x' }],
        numbers: 'nope',
        banks: [{ id: 'ADCB', name: '' }],
      },
    });
    expect(r.interestedTagId).toBe(UUID);
    expect(r.tagHistory).toBe(true);
    expect(r.bySource).toHaveLength(2);
    expect(r.bySource[0].counts.new_chats).toBe(5);
    expect(r.bySource[1].key).toBeNull();
    expect(r.byAgent[0].name).toBe('Sara');
    expect(r.byBank[0].counts).toEqual({
      case_opened: 2,
      submitted: 0,
      approved: 0,
      declined: 0,
      withdrawn: 0,
    });
    expect(r.daily.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02']);
    expect(r.daily[0]).toEqual({
      day: '2026-11-01',
      newChats: 2,
      interested: 1,
      caseOpened: 1,
    });
    expect(r.options.agents).toEqual([{ id: UUID, name: 'Sara' }]);
    expect(r.options.numbers).toEqual([]);
    expect(r.options.banks).toEqual([{ id: 'ADCB', name: null }]);
  });
});

describe('conversionSteps', () => {
  it('gives % of the previous stage and of new chats', () => {
    const steps = conversionSteps({
      new_chats: 200,
      interested: 50,
      case_opened: 20,
      submitted: 10,
      approved: 3,
    });
    expect(steps.map((s) => s.stage)).toEqual([
      'new_chats',
      'interested',
      'case_opened',
      'submitted',
      'approved',
    ]);
    expect(steps[0]).toEqual({
      stage: 'new_chats',
      count: 200,
      ofPrevious: null,
      ofNewChats: 100,
    });
    expect(steps[1].ofPrevious).toBe(25);
    expect(steps[2].ofPrevious).toBe(40);
    expect(steps[4].ofPrevious).toBe(30);
    expect(steps[4].ofNewChats).toBe(1.5);
  });

  it('answers null, never NaN or Infinity, for a zero denominator', () => {
    const steps = conversionSteps({
      new_chats: 0,
      interested: 0,
      case_opened: 0,
    });
    for (const s of steps) {
      expect(s.ofNewChats).toBeNull();
      expect(s.ofPrevious).toBeNull();
    }
    const mid = conversionSteps({
      new_chats: 10,
      interested: 0,
      case_opened: 0,
    });
    expect(mid[2].ofPrevious).toBeNull();
    expect(mid[2].ofNewChats).toBe(0);
  });

  it('survives a missing totals object', () => {
    expect(conversionSteps(null).every((s) => s.count === 0)).toBe(true);
  });

  it('percentOf rounds to one decimal', () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(2, 3)).toBe(66.7);
    expect(percentOf(1, 0)).toBeNull();
  });
});

describe('parseFunnelFilters', () => {
  const parse = (q: string) => parseFunnelFilters(new URLSearchParams(q));

  it('defaults to 30 days with no filters', () => {
    expect(parse('')).toEqual({
      ok: true,
      filters: {
        range: '30d',
        leadSource: null,
        agent: null,
        bank: null,
        channel: null,
        tz: null,
      },
    });
  });

  it('treats blank and "all" as no filter', () => {
    const r = parse('lead_source=&agent=all&bank=%20&channel=');
    expect(r.ok && r.filters).toMatchObject({
      leadSource: null,
      agent: null,
      bank: null,
      channel: null,
    });
  });

  it('accepts every known value', () => {
    const r = parse(
      `range=90d&lead_source=none&agent=${UUID}&bank=ADCB_2&channel=${UUID}&tz=Asia/Dubai`
    );
    expect(r).toEqual({
      ok: true,
      filters: {
        range: '90d',
        leadSource: 'none',
        agent: UUID,
        bank: 'ADCB_2',
        channel: UUID,
        tz: 'Asia/Dubai',
      },
    });
  });

  it.each([
    ['range=1y', 'range'],
    ['lead_source=facebook', 'lead_source'],
    ['lead_source=AD', 'lead_source'],
    ['agent=not-a-uuid', 'agent'],
    ['bank=adcb', 'bank'],
    ['bank=A', 'bank'],
    [`bank=${'A'.repeat(33)}`, 'bank'],
    ["bank=AD'CB", 'bank'],
    ['channel=123', 'channel'],
  ])('refuses %s', (q, field) => {
    expect(parse(q)).toEqual({ ok: false, field });
  });

  it('round-trips through funnelQueryString', () => {
    const r = parse(`range=7d&lead_source=ad&bank=ENBD&tz=UTC`);
    if (!r.ok) throw new Error('expected ok');
    expect(parse(funnelQueryString(r.filters))).toEqual(r);
    expect(funnelQueryString({ ...r.filters, leadSource: null })).toBe(
      'range=7d&bank=ENBD&tz=UTC'
    );
  });

  it("lists the lead sources 254 accepts: LEAD_SOURCES plus 'none'", () => {
    expect(FUNNEL_LEAD_SOURCES).toEqual([...LEAD_SOURCES, 'none']);
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/254_funnel_report.sql'),
      'utf8'
    );
    const m = sql.match(/p_lead_source NOT IN \(([^)]*)\)/);
    const listed = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter(Boolean);
    expect([...listed].sort()).toEqual([...FUNNEL_LEAD_SOURCES].sort());
  });
});

describe('fillFunnelDays and zonedDay', () => {
  it('fills the quiet days with zeros', () => {
    const out = fillFunnelDays(
      [{ day: '2026-11-03', newChats: 4, interested: 1, caseOpened: 0 }],
      '2026-11-01',
      '2026-11-04'
    );
    expect(out.map((d) => [d.day, d.newChats])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 0],
      ['2026-11-03', 4],
      ['2026-11-04', 0],
    ]);
  });

  it('crosses a month end and keeps the input on bad bounds', () => {
    expect(fillFunnelDays([], '2026-10-31', '2026-11-01')).toHaveLength(2);
    const daily = [
      { day: '2026-11-03', newChats: 1, interested: 0, caseOpened: 0 },
    ];
    expect(fillFunnelDays(daily, 'x', '2026-11-04')).toEqual(daily);
    expect(fillFunnelDays(daily, '2026-11-05', '2026-11-04')).toEqual(daily);
  });

  it('reads the local day in the zone', () => {
    const instant = new Date('2026-11-21T21:30:00Z');
    expect(zonedDay(instant, 'Asia/Dubai')).toBe('2026-11-22');
    expect(zonedDay(instant, 'UTC')).toBe('2026-11-21');
  });
});

describe('funnelCsvRows', () => {
  const report = parseFunnelReport({
    totals: {
      new_chats: 10,
      interested: 5,
      case_opened: 2,
      submitted: 1,
      approved: 1,
      declined: 1,
      withdrawn: 0,
    },
    by_source: [{ key: 'none', new_chats: 10 }],
    by_agent: [{ key: null, name: null, new_chats: 10 }],
    by_number: [{ key: UUID, name: '=cmd()', new_chats: 10 }],
    by_bank: [{ key: 'ADCB', name: null, case_opened: 2 }],
  });

  it('builds totals, conversions and one row per breakdown item', () => {
    const { header, rows } = funnelCsvRows(report, labels);
    expect(header).toEqual(['Breakdown', 'Item', ...FUNNEL_METRICS]);
    expect(rows[0]).toEqual(['Total', 'All', 10, 5, 2, 1, 1, 1, 0]);
    expect(rows[1]).toEqual([
      '% prev',
      'All',
      null,
      50,
      40,
      50,
      100,
      null,
      null,
    ]);
    expect(rows[2]).toEqual(['% new', 'All', 100, 50, 20, 10, 10, null, null]);
    expect(rows[3].slice(0, 3)).toEqual(['Source', 'src:none', 10]);
    expect(rows[4].slice(0, 2)).toEqual(['Agent', 'Unassigned']);
    // Neutralising the formula is buildCsv's job; the row keeps the name.
    expect(rows[5].slice(0, 2)).toEqual(['Number', '=cmd()']);
    expect(rows[6]).toEqual(['Bank', 'ADCB', null, null, 2, 0, 0, 0, 0]);
    expect(rows.every((r) => r.length === header.length)).toBe(true);
  });

  it('never prints an internal id for someone who left or a bare number', () => {
    const { rows } = funnelCsvRows(
      parseFunnelReport({
        by_agent: [{ key: UUID, name: null, new_chats: 1 }],
        by_number: [{ key: UUID, name: null, new_chats: 1 }],
      }),
      labels
    );
    const items = rows.map((r) => r[1]);
    expect(items).not.toContain(UUID);
    expect(items.filter((i) => i === 'Unnamed')).toHaveLength(2);
  });
});
