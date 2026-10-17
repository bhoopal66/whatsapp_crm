import { describe, expect, it } from 'vitest';

import {
  DETAIL_KPI_KEYS,
  EVERYONE,
  HERO_TILES,
  KPI_KEYS,
  POINT_DELTA_KEYS,
  callListQuery,
  csvCell,
  deltaPoints,
  deltaTone,
  heatLevel,
  heatmapMatrix,
  heroTileValue,
  isSingleDay,
  mergeCalls,
  nextPageTo,
  periodButtons,
  readReportParams,
  reportSearch,
  reportView,
  sortPeople,
  statsCsvRows,
  statsQuery,
  toCsv,
  zoneDay,
  type StatsCsvLabels,
} from './call-stats-ui';
import {
  delta,
  type CallStats,
  type CallStatsPerson,
  type CallStatsSummary,
} from './call-stats';

const U = '00000000-0000-4000-8000-0000000000aa';
const params = (qs: string) => {
  const q = new URLSearchParams(qs);
  return readReportParams((k) => q.get(k));
};

const summary = (p: Partial<CallStatsSummary> = {}): CallStatsSummary => ({
  calls: 0,
  inboundTotal: 0,
  inboundAnswered: 0,
  outboundTotal: 0,
  outboundAnswered: 0,
  missed: 0,
  answerRate: null,
  talkSecondsTotal: 0,
  talkCalls: 0,
  avgTalkSeconds: null,
  longestTalkSeconds: null,
  ringSecondsTotal: 0,
  ringCalls: 0,
  avgRingSeconds: null,
  maxRingSeconds: null,
  uniqueNumbers: 0,
  withOutcome: 0,
  ...p,
});
const person = (
  name: string | null,
  p: Partial<CallStatsSummary> = {},
  kind: 'person' | 'none' = 'person'
): CallStatsPerson => ({
  kind,
  userId: kind === 'none' ? null : `id-${name}`,
  fullName: name,
  extension: null,
  ...summary(p),
});

describe('the report URL', () => {
  it('opens on me, today, and reads period, custom days and person', () => {
    expect(params('')).toEqual({
      period: 'today',
      from: null,
      to: null,
      user: null,
    });
    expect(params('period=bogus&user=nope')).toMatchObject({
      period: 'today',
      user: null,
    });
    expect(params(`period=last_week&user=${U}`)).toEqual({
      period: 'last_week',
      from: null,
      to: null,
      user: U,
    });
    expect(params('period=month&user=all')).toMatchObject({
      period: 'month',
      user: EVERYONE,
    });
    expect(params('period=custom&from=2026-10-01&to=2026-10-05')).toEqual({
      period: 'custom',
      from: '2026-10-01',
      to: '2026-10-05',
      user: null,
    });
    // Backwards days are no days: the page asks for them again.
    expect(params('period=custom&from=2026-10-05&to=2026-10-01')).toMatchObject(
      { from: null, to: null }
    );
  });

  it('writes it back, leaving today and me out', () => {
    expect(reportSearch(params(''))).toBe('');
    expect(reportSearch(params('period=today'))).toBe('');
    expect(reportSearch(params('period=month'))).toBe('period=month');
    expect(reportSearch(params('user=all'))).toBe('user=all');
    const p = params(`period=custom&from=2026-10-01&to=2026-10-05&user=${U}`);
    expect(reportSearch(p)).toBe(
      `period=custom&from=2026-10-01&to=2026-10-05&user=${U}`
    );
  });

  it('asks for my own id by default, no user for everyone', () => {
    const me = '00000000-0000-4000-8000-0000000000bb';
    expect(statsQuery(params(''), 'UTC', me)).toBe(
      `period=today&tz=UTC&user=${me}`
    );
    // Me before the signed-in id is known: wait, never ask for everyone.
    expect(statsQuery(params(''), 'UTC', null)).toBeNull();
    expect(statsQuery(params('user=all'), 'UTC', me)).toBe(
      'period=today&tz=UTC'
    );
    const p = params(`period=custom&from=2026-10-01&to=2026-10-05&user=${U}`);
    expect(statsQuery(p, 'Asia/Dubai', me)).toBe(
      `period=custom&from=2026-10-01&to=2026-10-05&tz=Asia%2FDubai&user=${U}`
    );
    expect(statsQuery(params('period=custom'), 'UTC', me)).toBeNull();
  });

  it('names the view: me, everyone or one person', () => {
    expect(reportView(params(''), U)).toBe('me');
    expect(reportView(params(`user=${U}`), U)).toBe('me');
    expect(reportView(params('user=all'), U)).toBe('everyone');
    expect(reportView(params(`user=${U}`), null)).toBe('person');
  });

  it('shows four periods and custom, plus an old one while it is open', () => {
    expect(periodButtons('today')).toEqual([
      'today',
      'yesterday',
      'week',
      'month',
      'custom',
    ]);
    expect(periodButtons('custom')).toEqual(periodButtons('today'));
    expect(periodButtons('last_month')).toEqual([
      'today',
      'yesterday',
      'week',
      'month',
      'last_month',
      'custom',
    ]);
  });

  it('knows a one-day period', () => {
    expect(isSingleDay(params(''))).toBe(true);
    expect(isSingleDay(params('period=yesterday'))).toBe(true);
    expect(isSingleDay(params('period=week'))).toBe(false);
    expect(
      isSingleDay(params('period=custom&from=2026-10-01&to=2026-10-01'))
    ).toBe(true);
    expect(
      isSingleDay(params('period=custom&from=2026-10-01&to=2026-10-02'))
    ).toBe(false);
  });
});

describe('the hero and the details', () => {
  it('splits the tiles: talk time and four in the hero, the rest in details', () => {
    expect(HERO_TILES).toEqual(['calls', 'answered', 'missed', 'talkAverage']);
    expect(DETAIL_KPI_KEYS).toEqual([
      'inboundAnswered',
      'outbound',
      'answerRate',
      'longest',
      'ringAverage',
      'uniqueNumbers',
    ]);
  });

  it('counts answered both ways', () => {
    const s = summary({
      calls: 7,
      inboundAnswered: 3,
      outboundAnswered: 2,
      missed: 1,
      avgTalkSeconds: 40,
    });
    expect(heroTileValue(s, 'answered')).toBe(5);
    expect(heroTileValue(s, 'calls')).toBe(7);
    expect(heroTileValue(s, 'missed')).toBe(1);
    expect(heroTileValue(s, 'talkAverage')).toBe(40);
  });
});

describe('deltaTone', () => {
  it('is good when a figure moves its good way, bad the other, neutral flat', () => {
    expect(deltaTone('calls', delta(5, 3))).toBe('good');
    expect(deltaTone('calls', delta(3, 5))).toBe('bad');
    expect(deltaTone('missed', delta(5, 3))).toBe('bad');
    expect(deltaTone('missed', delta(3, 5))).toBe('good');
    expect(deltaTone('ringAverage', delta(20, 10))).toBe('bad');
    expect(deltaTone('talkTotal', delta(4, 4))).toBe('neutral');
    expect(deltaTone('answerRate', null)).toBe('neutral');
  });
});

describe('heatmapMatrix', () => {
  it('zero-fills Monday to Sunday by 0-23 and finds the busiest cell', () => {
    const { rows, max } = heatmapMatrix([
      { dow: 1, hour: 9, calls: 4, answered: 3, missed: 1, talkSeconds: 90 },
      { dow: 7, hour: 23, calls: 2, answered: 2, missed: 0, talkSeconds: 30 },
      { dow: 8, hour: 1, calls: 99, answered: 0, missed: 0, talkSeconds: 0 },
    ]);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.length === 24)).toBe(true);
    expect(rows[0][9]).toEqual({
      dow: 1,
      hour: 9,
      calls: 4,
      answered: 3,
      missed: 1,
      talkSeconds: 90,
    });
    expect(rows[6][23].calls).toBe(2);
    expect(rows[3][12].calls).toBe(0);
    expect(max).toBe(4);
  });

  it('levels a cell by its share of the busiest', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe('sortPeople', () => {
  const rows = [
    person(null, {}, 'none'),
    person('Sara', { talkSecondsTotal: 100, avgRingSeconds: null }),
    person('ali', { talkSecondsTotal: 300, avgRingSeconds: 5 }),
    person('Omar', { talkSecondsTotal: 200, avgRingSeconds: 9 }),
  ];
  const names = (r: CallStatsPerson[]) => r.map((p) => p.fullName);

  it('sorts by a figure either way, keeping the unassigned row last', () => {
    expect(names(sortPeople(rows, 'talkTotal', 'desc'))).toEqual([
      'ali',
      'Omar',
      'Sara',
      null,
    ]);
    expect(names(sortPeople(rows, 'talkTotal', 'asc'))).toEqual([
      'Sara',
      'Omar',
      'ali',
      null,
    ]);
  });

  it('puts a missing figure last both ways, and sorts names case-blind', () => {
    expect(names(sortPeople(rows, 'ringAverage', 'asc'))).toEqual([
      'ali',
      'Omar',
      'Sara',
      null,
    ]);
    expect(names(sortPeople(rows, 'ringAverage', 'desc'))).toEqual([
      'Omar',
      'ali',
      'Sara',
      null,
    ]);
    expect(names(sortPeople(rows, 'name', 'asc'))).toEqual([
      'ali',
      'Omar',
      'Sara',
      null,
    ]);
  });
});

describe('the call list', () => {
  const range = {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
  };
  const enc = (iso: string) => encodeURIComponent(iso);
  const tail = `from=${enc(range.from)}&to=${enc(range.to)}&limit=100`;
  const person = (userId: string | null, kind: 'person' | 'none' = 'person') =>
    ({ kind, userId }) as CallStatsPerson;

  it('lists my own calls by my id, never scope=mine', () => {
    const q = callListQuery('self', null, range, 100, null, U);
    expect(q).toBe(`scope=all&userId=${U}&direction=external&${tail}`);
    expect(q).not.toContain('scope=mine');
  });

  it('lists one person, all scope, external calls only', () => {
    expect(callListQuery('person', U, range, 5)).toBe(
      `scope=all&userId=${U}&direction=external&from=${enc(range.from)}&to=${enc(range.to)}&limit=5`
    );
  });

  it('lists a team by the people rows, and nothing when there are none', () => {
    const V = '00000000-0000-4000-8000-0000000000cc';
    expect(
      callListQuery(
        'team',
        null,
        range,
        100,
        [person(U), person(null, 'none'), person(V)],
        'me'
      )
    ).toBe(
      `scope=all&userIds=${U},${V}&direction=external&${tail}`.replace(
        /,/g,
        '%2C'
      )
    );
    expect(
      callListQuery('team', null, range, 100, [person(null, 'none')])
    ).toBeNull();
    expect(callListQuery('team', null, range, 100, [])).toBeNull();
  });

  it('lists the whole workspace, external calls only', () => {
    expect(callListQuery('workspace', null, range)).toBe(
      `scope=all&direction=external&${tail}`
    );
  });

  it('shows the answer rate as points and dates in the zone', () => {
    expect(POINT_DELTA_KEYS.has('answerRate')).toBe(true);
    expect(POINT_DELTA_KEYS.has('missed')).toBe(false);
    expect(deltaPoints(0.064)).toBe(6);
    expect(deltaPoints(-0.0612)).toBe(6);
    expect(zoneDay('2026-09-30T20:00:00.000Z', 'Asia/Dubai')).toBe(
      '2026-10-01'
    );
    expect(zoneDay('2026-09-30T20:00:00.000Z', 'UTC')).toBe('2026-09-30');
  });

  it('pages from just past the oldest call, dropping repeats', () => {
    const page = [
      { id: 'a', startedAt: '2026-10-01T10:00:00.000Z' },
      { id: 'b', startedAt: '2026-10-01T09:00:00.000Z' },
    ];
    expect(nextPageTo(page)).toBe('2026-10-01T09:00:00.001Z');
    expect(nextPageTo([])).toBeNull();
    expect(
      mergeCalls(page, [
        { id: 'b', startedAt: '2026-10-01T09:00:00.000Z' },
        { id: 'c', startedAt: '2026-10-01T09:00:00.000Z' },
      ]).map((c) => c.id)
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(0.5)).toBe('0.5');
    expect(csvCell(NaN)).toBe('');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      `"'=HYPERLINK(""http://x"")"`
    );
    expect(csvCell('+971501234567')).toBe("'+971501234567");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    // Numbers are data, never text a sheet would evaluate.
    expect(csvCell(-3)).toBe('-3');
  });

  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 1], [], ['b,c', null]])).toBe('a,1\r\n\r\n"b,c",\r\n');
  });

  it('writes the summary, the days and the people with totals', () => {
    const L: StatsCsvLabels = {
      section: { summary: 'Summary', days: 'By day', people: 'By person' },
      metric: 'Metric',
      current: 'This period',
      previous: 'Previous period',
      kpi: Object.fromEntries(
        KPI_KEYS.map((k) => [k, k])
      ) as StatsCsvLabels['kpi'],
      day: 'Day',
      dayColumns: {
        calls: 'Calls',
        inboundAnswered: 'Answered',
        outbound: 'Outbound',
        outboundAnswered: 'Outbound answered',
        missed: 'Missed',
        talkSeconds: 'Talk (s)',
      },
      person: 'Person',
      extension: 'Ext',
      peopleColumns: {
        calls: 'c',
        inboundAnswered: 'ia',
        outbound: 'o',
        missed: 'm',
        answerRate: 'ar',
        talkTotal: 'tt',
        talkAverage: 'ta',
        longest: 'l',
        ringAverage: 'ra',
      },
      unassigned: 'Ring groups / unassigned',
      unnamed: 'Unnamed',
      total: 'Total',
    };
    const stats = {
      summary: summary({ calls: 3, missed: 1, answerRate: 0.5 }),
      previous: summary({ calls: 1 }),
      byDay: [
        {
          day: '2026-10-01',
          calls: 3,
          inboundAnswered: 1,
          outbound: 1,
          outboundAnswered: 1,
          missed: 1,
          talkSeconds: 70,
        },
      ],
      people: [
        { ...person('=Eve', { calls: 2 }), extension: '201' },
        person(null, { calls: 1 }, 'none'),
      ],
    } as unknown as CallStats;
    const csv = toCsv(statsCsvRows(stats, L)).split('\r\n');
    expect(csv.slice(0, 4)).toEqual([
      'Summary',
      'Metric,This period,Previous period',
      'calls,3,1',
      'inboundAnswered,0,0',
    ]);
    expect(csv).toContain('answerRate,0.5,');
    expect(csv).toContain('2026-10-01,3,1,1,1,1,70');
    expect(csv).toContain("'=Eve,201,2,0,0,0,,0,,,");
    expect(csv).toContain('Ring groups / unassigned,,1,0,0,0,,0,,,');
    expect(csv).toContain('Total,,3,0,0,1,0.5,0,,,');
    expect(toCsv(statsCsvRows({ ...stats, people: null }, L))).not.toContain(
      'By person'
    );
  });
});
