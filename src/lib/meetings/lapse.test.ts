import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  INSTANT_LAPSE_MS,
  lapsedInstantMeetings,
  runMeetingLapseSweep,
  type LapseMeeting,
  type LapseSeat,
} from './lapse';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const meeting = (over: Partial<LapseMeeting> = {}): LapseMeeting => ({
  id: 'm1',
  status: 'scheduled',
  scheduled_start: null,
  created_at: ago(30 * MIN),
  ...over,
});

const seat = (over: Partial<LapseSeat> = {}): LapseSeat => ({
  meeting_id: 'm1',
  joined_at: ago(25 * MIN),
  last_seen_at: ago(20 * MIN),
  left_at: ago(20 * MIN),
  ...over,
});

describe('lapsedInstantMeetings', () => {
  it('lapses an empty meeting older than 10 minutes', () => {
    expect(lapsedInstantMeetings([meeting()], [], NOW)).toEqual(['m1']);
  });

  it('keeps one younger than 10 minutes', () => {
    const m = meeting({ created_at: ago(INSTANT_LAPSE_MS - MIN) });
    expect(lapsedInstantMeetings([m], [], NOW)).toEqual([]);
  });

  it('keeps a meeting someone is present in', () => {
    const s = seat({ last_seen_at: ago(10_000), left_at: null });
    expect(lapsedInstantMeetings([meeting()], [s], NOW)).toEqual([]);
  });

  it('holds open for a seat that left 5 minutes ago, not 11', () => {
    const recent = seat({ left_at: ago(5 * MIN), last_seen_at: ago(5 * MIN) });
    expect(lapsedInstantMeetings([meeting()], [recent], NOW)).toEqual([]);
    const old = seat({ left_at: ago(11 * MIN), last_seen_at: ago(11 * MIN) });
    expect(lapsedInstantMeetings([meeting()], [old], NOW)).toEqual(['m1']);
  });

  it('lapses a dead tab (no left_at, stale last_seen_at) after 10 minutes', () => {
    const dead = (min: number) =>
      seat({ left_at: null, last_seen_at: ago(min * MIN) });
    expect(lapsedInstantMeetings([meeting()], [dead(5)], NOW)).toEqual([]);
    expect(lapsedInstantMeetings([meeting()], [dead(11)], NOW)).toEqual(['m1']);
  });

  it('never lapses a scheduled meeting', () => {
    const m = meeting({ scheduled_start: ago(-60 * MIN) });
    expect(lapsedInstantMeetings([m], [], NOW)).toEqual([]);
  });

  it('ignores ended meetings', () => {
    expect(
      lapsedInstantMeetings([meeting({ status: 'ended' })], [], NOW)
    ).toEqual([]);
  });

  it('does not lapse on bad dates', () => {
    expect(
      lapsedInstantMeetings([meeting({ created_at: 'nope' })], [], NOW)
    ).toEqual([]);
    expect(
      lapsedInstantMeetings(
        [meeting()],
        [seat({ left_at: null, last_seen_at: 'nope' })],
        NOW
      )
    ).toEqual([]);
  });

  it('only counts seats of the same meeting', () => {
    const other = seat({
      meeting_id: 'm2',
      left_at: null,
      last_seen_at: ago(1000),
    });
    expect(lapsedInstantMeetings([meeting()], [other], NOW)).toEqual(['m1']);
  });
});

type Result = { data: unknown; error: { message: string } | null };

/** Each meeting's seats are their own read; `seatReads` records the order. */
function fakeAdmin(opts: {
  meetings: Result;
  seats?: Record<string, Result>;
  failUpdateFor?: string[];
}) {
  const updates: { patch: unknown; filters: [string, unknown][] }[] = [];
  const seatReads: string[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.is = (col: string, val: unknown) => (filters.push([col, val]), b);
    b.eq = (col: string, val: unknown) => (filters.push([col, val]), b);
    b.lt = () => b;
    b.order = () => b;
    b.limit = () => {
      if (table === 'meetings') return Promise.resolve(opts.meetings);
      const id = filters.find(([c]) => c === 'meeting_id')?.[1] as string;
      seatReads.push(id);
      return Promise.resolve(opts.seats?.[id] ?? { data: [], error: null });
    };
    b.update = (patch: unknown) => {
      const u = { patch, filters: [] as [string, unknown][] };
      updates.push(u);
      const ub: Record<string, unknown> = {};
      ub.eq = (col: string, val: unknown) => (u.filters.push([col, val]), ub);
      ub.is = (col: string, val: unknown) => {
        u.filters.push([col, val]);
        const id = u.filters.find(([c]) => c === 'id')?.[1] as string;
        return Promise.resolve({
          error: opts.failUpdateFor?.includes(id) ? { message: 'boom' } : null,
        });
      };
      return ub;
    };
    return b;
  };
  return {
    admin: { from } as unknown as SupabaseClient,
    updates,
    seatReads,
  };
}

describe('runMeetingLapseSweep', () => {
  const old = () => new Date(Date.now() - 30 * MIN).toISOString();
  const live = (id: string) => ({
    meeting_id: id,
    joined_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    left_at: null,
  });

  it('returns early when there are no instant meetings', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: { data: [], error: null },
    });
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 0,
      ended: 0,
    });
    expect(updates).toEqual([]);
  });

  it('ends only the meeting nobody is in, conditionally', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: {
        data: ['a', 'b'].map((id) => meeting({ id, created_at: old() })),
        error: null,
      },
      seats: { b: { data: [live('b')], error: null } },
    });
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 2,
      ended: 1,
    });
    expect(updates).toEqual([
      {
        patch: { status: 'ended' },
        filters: [
          ['id', 'a'],
          ['status', 'scheduled'],
          ['scheduled_start', null],
        ],
      },
    ]);
  });

  it('reads each meeting on its own, so a capped batch cannot hide a seat', async () => {
    const { admin, seatReads } = fakeAdmin({
      meetings: {
        data: ['a', 'b', 'c'].map((id) => meeting({ id, created_at: old() })),
        error: null,
      },
    });
    await runMeetingLapseSweep(admin);
    expect(seatReads).toEqual(['a', 'b', 'c']);
  });

  it('never ends a meeting whose seats could not be read', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: {
        data: ['a', 'b'].map((id) => meeting({ id, created_at: old() })),
        error: null,
      },
      seats: { a: { data: null, error: { message: 'down' } } },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 2,
      ended: 1,
    });
    expect(updates.map((u) => u.filters[0])).toEqual([['id', 'b']]);
    log.mockRestore();
  });

  it('continues past one failed update', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: {
        data: ['a', 'b', 'c'].map((id) => meeting({ id, created_at: old() })),
        error: null,
      },
      failUpdateFor: ['a'],
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 3,
      ended: 2,
    });
    expect(updates).toHaveLength(3);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('throws when the candidates cannot be read', async () => {
    const { admin } = fakeAdmin({
      meetings: { data: null, error: { message: 'down' } },
    });
    await expect(runMeetingLapseSweep(admin)).rejects.toThrow('down');
  });
});
