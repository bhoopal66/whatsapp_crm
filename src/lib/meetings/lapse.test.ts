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

function fakeAdmin(opts: {
  meetings: Result;
  seats: Result;
  failUpdateFor?: string[];
}) {
  const updates: { patch: unknown; eqs: [string, unknown][] }[] = [];
  const from = () => {
    const calls: [string, ...unknown[]][] = [];
    const log = (name: string) =>
      vi.fn((...args: unknown[]) => {
        calls.push([name, ...args]);
        return b;
      });
    const b: Record<string, unknown> = {};
    b.select = log('select');
    b.eq = log('eq');
    b.is = log('is');
    b.lt = log('lt');
    b.limit = vi.fn(() => Promise.resolve(opts.meetings));
    b.in = vi.fn(() => Promise.resolve(opts.seats));
    b.update = vi.fn((patch: unknown) => {
      const u = { patch, eqs: [] as [string, unknown][] };
      updates.push(u);
      const ub: Record<string, unknown> = {};
      ub.eq = (col: string, val: unknown) => {
        u.eqs.push([col, val]);
        if (u.eqs.length < 2) return ub;
        const id = u.eqs.find(([c]) => c === 'id')?.[1] as string;
        return Promise.resolve({
          error: opts.failUpdateFor?.includes(id) ? { message: 'boom' } : null,
        });
      };
      return ub;
    });
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, updates };
}

describe('runMeetingLapseSweep', () => {
  it('returns early when there are no instant meetings', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: { data: [], error: null },
      seats: { data: [], error: null },
    });
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 0,
      ended: 0,
    });
    expect(updates).toEqual([]);
  });

  it('ends lapsed meetings with a conditional update', async () => {
    const { admin, updates } = fakeAdmin({
      meetings: {
        data: [
          {
            ...meeting({
              id: 'a',
              created_at: new Date(Date.now() - 30 * MIN).toISOString(),
            }),
          },
          {
            ...meeting({
              id: 'b',
              created_at: new Date(Date.now() - 30 * MIN).toISOString(),
            }),
          },
        ],
        error: null,
      },
      seats: {
        data: [
          {
            meeting_id: 'b',
            joined_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            left_at: null,
          },
        ],
        error: null,
      },
    });
    expect(await runMeetingLapseSweep(admin)).toEqual({
      checked: 2,
      ended: 1,
    });
    expect(updates).toEqual([
      {
        patch: { status: 'ended' },
        eqs: [
          ['id', 'a'],
          ['status', 'scheduled'],
        ],
      },
    ]);
  });

  it('continues past one failed update', async () => {
    const old = new Date(Date.now() - 30 * MIN).toISOString();
    const { admin, updates } = fakeAdmin({
      meetings: {
        data: ['a', 'b', 'c'].map((id) => meeting({ id, created_at: old })),
        error: null,
      },
      seats: { data: [], error: null },
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

  it('throws on a read error', async () => {
    const { admin } = fakeAdmin({
      meetings: { data: null, error: { message: 'down' } },
      seats: { data: [], error: null },
    });
    await expect(runMeetingLapseSweep(admin)).rejects.toThrow('down');
  });
});
