import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dueRecurringReminders,
  RECURRING_MAX_ROWS,
  RECURRING_PAGE_SIZE,
  runRecurringReminders,
  type ReminderAttendeeRow,
  type ReminderEventRow,
} from './reminders';

const EV = 'AAAAAAAA-0000-4000-8000-000000000001';
const ME = 'BBBBBBBB-0000-4000-8000-000000000001';
const at = (s: string) => Date.parse(s);

// Daily at 09:00 Dubai (05:00 UTC) from 1 Oct 2026, 10 minutes' notice.
const series = (patch: Partial<ReminderEventRow> = {}): ReminderEventRow => ({
  id: EV,
  created_by: ME,
  start_at: '2026-10-01T05:00:00Z',
  end_at: '2026-10-01T05:30:00Z',
  all_day: false,
  time_zone: 'Asia/Dubai',
  rrule: 'FREQ=DAILY',
  exdates: [],
  reminders: [10],
  status: 'confirmed',
  ...patch,
});

const attendee = (
  user_id: string,
  response: ReminderAttendeeRow['response'],
  reminders: number[] | null = null
): ReminderAttendeeRow => ({ event_id: EV, user_id, response, reminders });

const ROWS = [
  attendee('accepted-1', 'accepted'),
  attendee('declined-1', 'declined'),
  attendee('pending-1', 'pending', [60]),
];

const who = (r: { userId: string; offset: number }[]) =>
  r.map((x) => `${x.userId}@${x.offset}`).sort();

describe('dueRecurringReminders', () => {
  it('rings the organiser and non-declined attendees, each on their own offsets', () => {
    const due = dueRecurringReminders({
      events: [series()],
      attendeeRows: ROWS,
      now: at('2026-10-20T04:50:00Z'),
    });
    expect(due).toContainEqual({
      key: `ev:${EV.toLowerCase()}:${at('2026-10-20T05:00:00Z') / 1000}:10:${ME.toLowerCase()}`,
      userId: ME,
      eventId: EV,
      occurrenceStart: '2026-10-20T05:00:00.000Z',
      offset: 10,
    });
    // pending-1 overrides to 60 minutes, so not due at 04:50.
    expect(who(due)).toEqual([`${ME}@10`, `accepted-1@10`]);
    expect(
      who(
        dueRecurringReminders({
          events: [series()],
          attendeeRows: ROWS,
          now: at('2026-10-20T04:00:30Z'),
        })
      )
    ).toEqual(['pending-1@60']);
  });

  it('never rings someone who declined', () => {
    const due = dueRecurringReminders({
      events: [series()],
      attendeeRows: [attendee('declined-1', 'declined', [10])],
      now: at('2026-10-20T04:50:00Z'),
    });
    expect(due.map((d) => d.userId)).toEqual([ME]);
  });

  it('uses the window (now - 5 min, now]', () => {
    const run = (now: string) =>
      dueRecurringReminders({
        events: [series()],
        attendeeRows: [],
        now: at(now),
      }).length;
    expect(run('2026-10-20T04:50:00Z')).toBe(1); // exactly due
    expect(run('2026-10-20T04:54:59Z')).toBe(1);
    expect(run('2026-10-20T04:55:00Z')).toBe(0); // 5 minutes late: gone
    expect(run('2026-10-20T04:49:59Z')).toBe(0); // not yet
  });

  it('reaches 28 days ahead and skips exdates, one-offs and cancelled series', () => {
    const now = at('2026-10-20T05:00:00Z');
    const ahead = dueRecurringReminders({
      events: [series({ reminders: [40320] })],
      attendeeRows: [],
      now,
    });
    expect(ahead.map((d) => d.occurrenceStart)).toEqual([
      '2026-11-17T05:00:00.000Z',
    ]);
    for (const ev of [
      series({ exdates: ['2026-10-20T05:00:00Z'], reminders: [0] }),
      series({ rrule: null, start_at: '2026-10-20T05:00:00Z', reminders: [0] }),
      series({ status: 'cancelled', reminders: [0] }),
      series({ reminders: [] }),
    ]) {
      expect(
        dueRecurringReminders({ events: [ev], attendeeRows: [], now })
      ).toEqual([]);
    }
  });
});

function mockAdmin(opts: {
  rows?: unknown[];
  /** Successive reads' rows (overrides rows). */
  pages?: () => unknown[] | null;
  error?: unknown;
  rpc?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
}) {
  const query: unknown[][] = [];
  const rpcCalls: [string, Record<string, unknown>][] = [];
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'eq',
    'not',
    'lte',
    'or',
    'gt',
    'order',
    'limit',
  ]) {
    chain[m] = (...args: unknown[]) => {
      query.push([m, ...args]);
      return chain;
    };
  }
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve({
      data: opts.pages ? opts.pages() : (opts.rows ?? null),
      error: opts.error ?? null,
    }).then(ok, bad);
  const client = {
    from: (table: string) => {
      query.push(['from', table]);
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push([fn, args]);
      return opts.rpc ? opts.rpc(args) : { data: true, error: null };
    },
  };
  return { admin: client as unknown as SupabaseClient, query, rpcCalls };
}

describe('runRecurringReminders', () => {
  afterEach(() => vi.restoreAllMocks());
  const now = new Date('2026-10-20T04:50:00Z');
  const row = {
    ...series(),
    calendar_event_attendees: [
      { user_id: 'accepted-1', response: 'accepted', reminders: null },
      { user_id: 'declined-1', response: 'declined', reminders: null },
    ],
  };

  it('reads confirmed series and rings each due tuple through the RPC', async () => {
    const { admin, query, rpcCalls } = mockAdmin({ rows: [row] });
    await expect(runRecurringReminders(admin, now)).resolves.toBe(2);
    expect(query).toContainEqual(['from', 'calendar_events']);
    expect(query).toContainEqual(['eq', 'status', 'confirmed']);
    expect(query).toContainEqual(['not', 'rrule', 'is', null]);
    expect(query).toContainEqual([
      'lte',
      'start_at',
      '2026-11-17T04:50:00.000Z',
    ]);
    expect(query).toContainEqual([
      'or',
      'series_end_at.is.null,series_end_at.gte.2026-10-20T04:45:00.000Z',
    ]);
    expect(query).toContainEqual(['order', 'id']);
    expect(query).toContainEqual(['limit', RECURRING_PAGE_SIZE]);
    expect(query.some((q) => q[0] === 'gt')).toBe(false);
    expect(rpcCalls.map(([fn, a]) => [fn, a.p_user, a.p_offset])).toEqual([
      ['calendar_insert_reminder', ME, 10],
      ['calendar_insert_reminder', 'accepted-1', 10],
    ]);
    expect(rpcCalls[0][1]).toEqual({
      p_key: `ev:${EV.toLowerCase()}:${at('2026-10-20T05:00:00Z') / 1000}:10:${ME.toLowerCase()}`,
      p_user: ME,
      p_event: EV,
      p_occurrence_start: '2026-10-20T05:00:00.000Z',
      p_offset: 10,
    });
  });

  it('counts only reminders that rang and never throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = mockAdmin({
      rows: [row, { ...row, id: 'broken', rrule: 'FREQ=DAILY;COUNT=0' }],
      rpc: (a) =>
        a.p_user === ME
          ? { data: false, error: null } // already rung
          : { data: null, error: { message: 'boom' } },
    });
    await expect(runRecurringReminders(admin, now)).resolves.toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it('answers 0 when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, rpcCalls } = mockAdmin({ error: { message: 'down' } });
    await expect(runRecurringReminders(admin, now)).resolves.toBe(0);
    expect(rpcCalls).toEqual([]);
  });
});

describe('runRecurringReminders paging', () => {
  afterEach(() => vi.restoreAllMocks());
  const now = new Date('2026-10-20T04:50:00Z');
  // A series with nothing to ring: read, never expanded.
  const quiet = (i: number) => ({
    ...series({ id: `id-${String(i).padStart(6, '0')}`, reminders: [] }),
    calendar_event_attendees: [],
  });
  const page = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => quiet(from + i));

  it('reads page after page by id until a short page', async () => {
    const due = { ...series(), id: 'id-zzz', calendar_event_attendees: [] };
    const pages = [
      page(0, RECURRING_PAGE_SIZE),
      page(RECURRING_PAGE_SIZE, RECURRING_PAGE_SIZE),
      [due],
    ];
    const { admin, query, rpcCalls } = mockAdmin({
      pages: () => pages.shift() ?? [],
    });
    await expect(runRecurringReminders(admin, now)).resolves.toBe(1);
    expect(query.filter((q) => q[0] === 'gt')).toEqual([
      ['gt', 'id', 'id-000499'],
      ['gt', 'id', 'id-000999'],
    ]);
    expect(rpcCalls).toHaveLength(1);
    expect(pages).toEqual([]);
  });

  it('stops at RECURRING_MAX_ROWS and says so', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reads = 0;
    const { admin } = mockAdmin({
      pages: () => page(reads++ * RECURRING_PAGE_SIZE, RECURRING_PAGE_SIZE),
    });
    await expect(runRecurringReminders(admin, now)).resolves.toBe(0);
    expect(reads).toBe(RECURRING_MAX_ROWS / RECURRING_PAGE_SIZE);
    expect(log).toHaveBeenCalledWith(
      '[calendar] recurring reminders: stopped at',
      RECURRING_MAX_ROWS,
      'series this pass'
    );
  });
});
