import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { OFFLINE_AFTER_MS } from '@/lib/presence';

import { loadLiveTeamView, parseLiveTeamView, sortLivePeople } from './view';

function person(id: string, over: Record<string, unknown> = {}) {
  return {
    user_id: id,
    name: `Person ${id}`,
    email: `${id}@example.com`,
    role: 'agent',
    presence: 'online',
    last_seen_at: '2026-11-22T11:59:30Z',
    open_chats: 3,
    waiting_chats: 0,
    oldest_waiting_since: null,
    oldest_waiting_business_minutes: null,
    replies_today: 4,
    ...over,
  };
}

describe('parseLiveTeamView', () => {
  it('parses the figures and the admin count', () => {
    const v = parseLiveTeamView({
      people: [
        person('a', {
          waiting_chats: 2,
          oldest_waiting_since: '2026-11-22T11:00:00Z',
          oldest_waiting_business_minutes: 60,
        }),
      ],
      unassigned_waiting: 3,
      timezone: 'Asia/Dubai',
      scope: 'all',
      generated_at: '2026-11-22T12:00:00Z',
    });
    expect(v).toMatchObject({
      unassignedWaiting: 3,
      scope: 'all',
      timezone: 'Asia/Dubai',
    });
    expect(v?.people[0]).toMatchObject({
      userId: 'a',
      presence: 'online',
      openChats: 3,
      waitingChats: 2,
      oldestWaitingBusinessMinutes: 60,
      repliesToday: 4,
    });
  });

  it('a leader gets no unassigned count; junk is tolerated', () => {
    const v = parseLiveTeamView({
      people: [
        person('b', { presence: 'busy', open_chats: -1, name: '' }),
        { nope: true },
        null,
      ],
      unassigned_waiting: null,
      scope: 'team',
    });
    expect(v?.unassignedWaiting).toBeNull();
    expect(v?.scope).toBe('team');
    expect(v?.timezone).toBe('Asia/Dubai');
    expect(v?.people).toHaveLength(1);
    expect(v?.people[0]).toMatchObject({
      presence: 'offline',
      openChats: 0,
      name: 'b@example.com',
    });
    expect(parseLiveTeamView(null)).toBeNull();
    expect(parseLiveTeamView({ people: 'x' })).toBeNull();
  });
});

describe('sortLivePeople', () => {
  it('longest wait first, then online, away, offline by name', () => {
    const v = parseLiveTeamView({
      people: [
        person('z-off', { presence: 'offline', name: 'Zed' }),
        person('w2', { oldest_waiting_since: '2026-11-22T11:30:00Z' }),
        person('a-away', { presence: 'away', name: 'Amy' }),
        person('w1', { oldest_waiting_since: '2026-11-22T10:00:00Z' }),
        person('b-on', { name: 'Bob' }),
      ],
    });
    expect(v?.people.map((p) => p.userId)).toEqual([
      'w1',
      'w2',
      'b-on',
      'a-away',
      'z-off',
    ]);
    expect(sortLivePeople([])).toEqual([]);
  });
});

describe('loadLiveTeamView', () => {
  it('maps a refusal and a failure, never throws', async () => {
    const refuse = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }),
    } as unknown as SupabaseClient;
    expect(await loadLiveTeamView(refuse)).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    const boom = {
      rpc: vi.fn().mockRejectedValue(new Error('x')),
    } as unknown as SupabaseClient;
    expect(await loadLiveTeamView(boom)).toEqual({
      ok: false,
      reason: 'failed',
    });
    const ok = {
      rpc: vi.fn().mockResolvedValue({ data: { people: [] }, error: null }),
    } as unknown as SupabaseClient;
    const res = await loadLiveTeamView(ok);
    expect(res.ok).toBe(true);
  });
});

describe('migration 238', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '238_live_view.sql'),
    'utf8'
  );

  it('derives offline with the same window as lib/presence.ts', () => {
    expect(sql).toContain(`interval '${OFFLINE_AFTER_MS / 1000} seconds'`);
  });

  it('defaults to the response settings time zone', () => {
    expect(sql).toContain("'Asia/Dubai'");
  });
});
