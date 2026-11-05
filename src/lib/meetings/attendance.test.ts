import { describe, expect, it } from 'vitest';

import {
  attendanceCsv,
  attendanceSummary,
  LOCKED_REJOIN_WINDOW_MS,
  mayEnterLocked,
  summarizeAttendance,
  type AttendanceEntry,
  type AttendanceSeat,
} from './attendance';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('mayEnterLocked', () => {
  const open = (seenAgo: number) => ({
    left_at: null,
    last_seen_at: ago(seenAgo),
  });
  const closed = (leftAgo: number) => ({
    left_at: ago(leftAgo),
    last_seen_at: ago(leftAgo),
  });

  it('refuses someone who never had a seat', () => {
    expect(mayEnterLocked([], NOW)).toBe(false);
  });

  it('lets a live open seat in', () => {
    expect(mayEnterLocked([open(10_000)], NOW)).toBe(true);
  });

  it('refuses a tab that died long before the lock', () => {
    expect(mayEnterLocked([open(LOCKED_REJOIN_WINDOW_MS + 1)], NOW)).toBe(
      false
    );
  });

  it('lets a seat closed within the window in, up to its edge', () => {
    expect(mayEnterLocked([closed(60_000)], NOW)).toBe(true);
    expect(mayEnterLocked([closed(LOCKED_REJOIN_WINDOW_MS)], NOW)).toBe(true);
  });

  it('refuses a seat closed before the window, or an unreadable time', () => {
    expect(mayEnterLocked([closed(LOCKED_REJOIN_WINDOW_MS + 1)], NOW)).toBe(
      false
    );
    expect(
      mayEnterLocked([{ left_at: 'nonsense', last_seen_at: ago(1) }], NOW)
    ).toBe(false);
  });

  it('needs only one qualifying seat', () => {
    expect(
      mayEnterLocked([closed(LOCKED_REJOIN_WINDOW_MS + 1), open(1000)], NOW)
    ).toBe(true);
  });
});

const MIN = 60_000;
/** Minutes after the fixed start of the meeting, as a timestamp. */
const START = NOW - 120 * MIN;
const at = (min: number) => new Date(START + min * MIN).toISOString();

/** A seat of `min` to `to` minutes, closed cleanly unless `open`. */
function seat(
  from: number,
  to: number,
  over: Partial<AttendanceSeat> = {}
): AttendanceSeat {
  return {
    user_id: 'u-1',
    joined_at: at(from),
    last_seen_at: at(to),
    left_at: at(to),
    removed_at: null,
    ...over,
  };
}

describe('summarizeAttendance', () => {
  const sum = (
    seats: AttendanceSeat[],
    endedAtMs: number | null | undefined = START + 120 * MIN
  ) => summarizeAttendance(seats, { nowMs: NOW, endedAtMs });

  it('gives nobody for no seats', () => {
    expect(sum([])).toEqual([]);
  });

  it('describes one closed seat', () => {
    expect(sum([seat(10, 40)])).toEqual([
      {
        userId: 'u-1',
        firstJoinedAt: at(10),
        lastLeftAt: at(40),
        totalMs: 30 * MIN,
        seats: 1,
        removed: false,
      },
    ]);
  });

  it('adds separate seats and leaves the gap out', () => {
    const [e] = sum([seat(0, 10), seat(30, 45)]);
    expect(e.totalMs).toBe(25 * MIN);
    expect(e.seats).toBe(2);
    expect(e.firstJoinedAt).toBe(at(0));
    expect(e.lastLeftAt).toBe(at(45));
  });

  it('counts a rejoin that overlaps the old seat once', () => {
    const [e] = sum([seat(0, 30), seat(29, 60)]);
    expect(e.totalMs).toBe(60 * MIN);
    expect(e.seats).toBe(2);
  });

  it('counts a seat inside another once, in any order', () => {
    expect(sum([seat(10, 20), seat(0, 60)])[0].totalMs).toBe(60 * MIN);
    expect(sum([seat(0, 60), seat(10, 20)])[0].totalMs).toBe(60 * MIN);
  });

  it("keeps people apart: an overlap is only one person's", () => {
    const entries = sum([seat(0, 30), seat(0, 30, { user_id: 'u-2' })]);
    expect(entries.map((e) => e.totalMs)).toEqual([30 * MIN, 30 * MIN]);
  });

  it('stops a dead tab at its last heartbeat', () => {
    const [e] = sum([seat(0, 15, { left_at: null })], null);
    expect(e.totalMs).toBe(15 * MIN);
    expect(e.lastLeftAt).toBe(at(15));
  });

  it('stops a dead tab the end closed at its last heartbeat too', () => {
    const [e] = sum([seat(0, 15, { left_at: at(120) })]);
    expect(e.totalMs).toBe(15 * MIN);
    expect(e.lastLeftAt).toBe(at(15));
  });

  it('leaves the gap out when a rejoin closed a dead tab late', () => {
    const [e] = sum([seat(0, 15, { left_at: at(50) }), seat(50, 70)]);
    expect(e.totalMs).toBe(35 * MIN);
  });

  it('believes a left_at within the presence window of the heartbeat', () => {
    const [e] = sum([
      seat(0, 30, { left_at: new Date(START + 31 * MIN).toISOString() }),
    ]);
    expect(e.totalMs).toBe(31 * MIN);
  });

  it('counts a live seat to now, as present', () => {
    const live = seat(100, 0, {
      last_seen_at: ago(10_000),
      left_at: null,
    });
    const [e] = sum([live], null);
    expect(e.totalMs).toBe(20 * MIN);
    expect(e.lastLeftAt).toBeNull();
  });

  it('reads a person as present when any one seat is live', () => {
    const live = seat(100, 0, { last_seen_at: ago(1_000), left_at: null });
    const [e] = sum([seat(0, 50), live], null);
    expect(e.lastLeftAt).toBeNull();
    expect(e.totalMs).toBe(70 * MIN);
  });

  it('treats a heartbeat at the window edge as gone, as isPresent does', () => {
    const edge = seat(100, 0, { last_seen_at: ago(MIN), left_at: null });
    const [e] = sum([edge], null);
    expect(e.lastLeftAt).toBe(ago(MIN));
    expect(e.totalMs).toBe(19 * MIN);
  });

  it('does not count a closed seat as live, however fresh', () => {
    const closed = seat(100, 0, {
      last_seen_at: ago(1_000),
      left_at: ago(500),
    });
    const [e] = sum([closed], null);
    expect(e.lastLeftAt).toBe(ago(500));
  });

  it('reads nobody as present once the meeting ended', () => {
    const open = seat(100, 0, { last_seen_at: ago(1_000), left_at: null });
    const [e] = sum([open], NOW - 2 * MIN);
    expect(e.lastLeftAt).toBe(ago(2 * MIN));
    expect(e.totalMs).toBe(18 * MIN);
  });

  it('clamps a seat to the end of the meeting', () => {
    const [e] = sum([seat(0, 90)], START + 60 * MIN);
    expect(e.totalMs).toBe(60 * MIN);
    expect(e.lastLeftAt).toBe(at(60));
  });

  it('ignores a seat that began after the end', () => {
    const entries = sum([seat(0, 30), seat(70, 90)], START + 60 * MIN);
    expect(entries[0].seats).toBe(1);
    expect(entries[0].totalMs).toBe(30 * MIN);
  });

  it('flags a removed person, from any seat', () => {
    const entries = sum([
      seat(0, 10, { removed_at: at(10) }),
      seat(20, 30),
      seat(0, 30, { user_id: 'u-2' }),
    ]);
    expect(entries.map((e) => [e.userId, e.removed])).toEqual([
      ['u-1', true],
      ['u-2', false],
    ]);
  });

  it('ignores zero-length, inverted and unreadable seats', () => {
    const [e] = sum([
      seat(0, 30),
      seat(40, 40),
      seat(50, 45),
      seat(0, 30, { joined_at: 'nonsense' }),
    ]);
    expect(e.seats).toBe(1);
    expect(e.totalMs).toBe(30 * MIN);
    expect(e.lastLeftAt).toBe(at(30));
  });

  it('has no entry for someone with only an empty seat', () => {
    expect(sum([seat(10, 10)])).toEqual([]);
  });

  it('sorts by first joined, then by user', () => {
    const entries = sum([
      seat(20, 30, { user_id: 'c' }),
      seat(5, 30, { user_id: 'b' }),
      seat(5, 30, { user_id: 'a' }),
    ]);
    expect(entries.map((e) => e.userId)).toEqual(['a', 'b', 'c']);
  });
});

const entry = (over: Partial<AttendanceEntry>): AttendanceEntry => ({
  userId: 'u-1',
  firstJoinedAt: at(0),
  lastLeftAt: at(30),
  totalMs: 30 * MIN,
  seats: 1,
  removed: false,
  ...over,
});

describe('attendanceSummary', () => {
  it('is empty for nobody', () => {
    expect(attendanceSummary([])).toEqual({
      people: 0,
      startedAt: null,
      endedAt: null,
      longestMs: 0,
    });
  });

  it('spans the first join to the last leave', () => {
    expect(
      attendanceSummary([
        entry({ firstJoinedAt: at(5), lastLeftAt: at(50), totalMs: 45 * MIN }),
        entry({ firstJoinedAt: at(0), lastLeftAt: at(20), totalMs: 20 * MIN }),
      ])
    ).toEqual({
      people: 2,
      startedAt: at(0),
      endedAt: at(50),
      longestMs: 45 * MIN,
    });
  });

  it('has no end while anyone is present', () => {
    const summary = attendanceSummary([
      entry({}),
      entry({ userId: 'u-2', lastLeftAt: null }),
    ]);
    expect(summary.endedAt).toBeNull();
  });
});

describe('attendanceCsv', () => {
  const labels = {
    name: 'Name',
    joined: 'Joined',
    left: 'Left',
    minutes: 'Minutes',
    seats: 'Joins',
    removed: 'Removed',
    stillPresent: 'In the call',
    yes: 'Yes',
  };
  const lines = (name: string, over: Partial<AttendanceEntry> = {}) =>
    attendanceCsv([entry(over)], () => name, labels).split('\r\n');
  const nameCell = (name: string) => lines(name)[1].split(`,${at(0)}`)[0];

  it('quotes a cell a semicolon-locale spreadsheet would split', () => {
    expect(nameCell('x;=HYPERLINK("a")')).toBe('"x;=HYPERLINK(""a"")"');
  });

  it('writes a heading and a row, CRLF throughout', () => {
    const csv = attendanceCsv(
      [entry({ totalMs: 90_000, seats: 2, removed: true })],
      () => 'Sara',
      labels
    );
    expect(csv).toBe(
      'Name,Joined,Left,Minutes,Joins,Removed\r\n' +
        `Sara,${at(0)},${at(30)},1.5,2,Yes\r\n`
    );
  });

  it('writes only the heading for nobody', () => {
    expect(attendanceCsv([], () => '', labels)).toBe(
      'Name,Joined,Left,Minutes,Joins,Removed\r\n'
    );
  });

  it('says so for someone still present, and blanks not-removed', () => {
    expect(lines('Sara', { lastLeftAt: null })[1]).toBe(
      `Sara,${at(0)},In the call,30.0,1,`
    );
  });

  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    expect(nameCell('Doe, Jane')).toBe('"Doe, Jane"');
    expect(nameCell('Jane "JD" Doe')).toBe('"Jane ""JD"" Doe"');
    const csv = attendanceCsv([entry({})], () => 'a\nb', labels);
    expect(csv).toContain('"a\nb",');
    expect(attendanceCsv([entry({})], () => 'a\r\nb', labels)).toContain(
      '"a\r\nb",'
    );
  });

  it.each(['=1+1', '+971501234567', '-2', '@SUM(A1)', '\tx'])(
    'defuses a formula opening with %j',
    (name) => {
      expect(nameCell(name)).toBe(`'${name}`);
    }
  );

  it('defuses a leading CR, and quotes it as well', () => {
    expect(attendanceCsv([entry({})], () => '\r=1', labels)).toContain(
      `"'\r=1",`
    );
  });

  it('defuses first and quotes after, so the quote stays outermost', () => {
    expect(nameCell('=HYPERLINK("http://x","y")')).toBe(
      `"'=HYPERLINK(""http://x"",""y"")"`
    );
  });

  it('leaves a formula character alone past the first place', () => {
    expect(nameCell('Jane=Doe')).toBe('Jane=Doe');
  });

  it('runs headings through the same guard', () => {
    const csv = attendanceCsv([], () => '', { ...labels, name: '=Name, x' });
    expect(csv.startsWith(`"'=Name, x",`)).toBe(true);
  });
});
