import { describe, expect, it, vi } from 'vitest';

import {
  keysOfLeavers,
  listLiveKeys,
  parseMadeKeys,
  type MadeKey,
} from './made-by';

const NOW = Date.parse('2026-11-23T12:00:00Z');

function client(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve(result)),
  };
  return { supabase: { from: vi.fn(() => builder) } as never, builder };
}

const row = (over: Record<string, unknown>) => ({
  id: 'k',
  name: 'n',
  last_used_at: null,
  created_by: 'u1',
  expires_at: null,
  revoked_at: null,
  ...over,
});

describe('listLiveKeys', () => {
  it('keeps live keys, drops revoked and expired ones', async () => {
    const { supabase, builder } = client({
      data: [
        row({ id: 'live', last_used_at: '2026-11-01T00:00:00Z' }),
        row({ id: 'future', expires_at: '2026-12-01T00:00:00Z' }),
        row({ id: 'revoked', revoked_at: '2026-11-02T00:00:00Z' }),
        row({ id: 'expired', expires_at: '2026-11-23T11:00:00Z' }),
        row({ id: 'orphan', created_by: null }),
      ],
      error: null,
    });
    const keys = await listLiveKeys(supabase, 'acc', NOW);
    expect(keys?.map((k) => k.id)).toEqual(['live', 'future', 'orphan']);
    expect(keys?.[0]).toEqual({
      id: 'live',
      name: 'n',
      lastUsedAt: '2026-11-01T00:00:00Z',
      createdBy: 'u1',
    });
    expect(builder.eq).toHaveBeenCalledWith('account_id', 'acc');
  });

  it('answers null when the read fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = client({ data: null, error: { message: 'boom' } });
    expect(await listLiveKeys(supabase, 'acc', NOW)).toBeNull();
    quiet.mockRestore();
  });
});

describe('keysOfLeavers', () => {
  const key = (id: string, createdBy: string | null): MadeKey => ({
    id,
    name: id,
    lastUsedAt: null,
    createdBy,
  });
  const people = [
    { user_id: 'owner', account_role: 'owner', deactivated_at: null },
    { user_id: 'admin', account_role: 'admin', deactivated_at: null },
    { user_id: 'gone', account_role: 'admin', deactivated_at: '2026-11-01' },
    { user_id: 'lowered', account_role: 'agent', deactivated_at: null },
    { user_id: 'lead', account_role: 'team_leader', deactivated_at: null },
  ];

  it('lists keys whose maker no longer stands behind them', () => {
    const keys = [
      key('a', 'owner'),
      key('b', 'admin'),
      key('c', 'gone'),
      key('d', 'lowered'),
      key('e', 'lead'),
      key('f', 'stranger'),
      key('g', null),
    ];
    expect(keysOfLeavers(keys, people).map((k) => k.id)).toEqual([
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
  });

  it('treats an unknown role as not an admin', () => {
    const odd = [
      { user_id: 'x', account_role: 'wizard', deactivated_at: null },
    ];
    expect(keysOfLeavers([key('a', 'x')], odd)).toHaveLength(1);
  });
});

describe('parseMadeKeys', () => {
  it('is null unless it is a list, and drops malformed rows', () => {
    expect(parseMadeKeys(undefined)).toBeNull();
    expect(parseMadeKeys({})).toBeNull();
    expect(
      parseMadeKeys([{ id: 'a', name: 'n', lastUsedAt: 'x' }, null, { id: 5 }])
    ).toEqual([{ id: 'a', name: 'n', lastUsedAt: 'x', createdBy: null }]);
  });
});
