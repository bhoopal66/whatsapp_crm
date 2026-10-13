import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

// The list is read with the service role (RLS hides these rows from a
// non-member admin), so the role gate in front of it is the whole
// protection: below admin, the service role must never be touched.

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  caller: { role: 'admin' as string, signedIn: true },
  calls: [] as { table: string; op: string; args: unknown[] }[],
  results: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (min: AccountRole) => {
    if (!mocks.caller.signedIn)
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    if (!hasMinRole(mocks.caller.role as AccountRole, min))
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    return {
      supabase: {},
      userId: ME,
      accountId: WS,
      role: mocks.caller.role,
      account: { id: WS, name: 'WS' },
    };
  },
  toErrorResponse: (err: { status?: number; message: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'order', 'limit']) {
        builder[op] = (...args: unknown[]) => {
          mocks.calls.push({ table, op, args });
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(mocks.results[table] ?? { data: [], error: null });
      return builder;
    },
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'http://localhost:8000',
}));

import { GET } from './route';

beforeEach(() => {
  mocks.caller.role = 'admin';
  mocks.caller.signedIn = true;
  mocks.calls.length = 0;
  mocks.results = {
    chat_channels: {
      data: [
        {
          id: 'p1',
          kind: 'private',
          name: 'Ops',
          created_at: '2026-01-01T00:00:00Z',
          archived_at: null,
          members: [{ user_id: 'u1' }, { user_id: 'u2' }],
          internal_messages: [{ created_at: '2026-02-01T00:00:00Z' }],
        },
        {
          id: 'joined',
          kind: 'private',
          name: 'Mine',
          created_at: '2026-01-01T00:00:00Z',
          archived_at: null,
          members: [{ user_id: ME }],
          internal_messages: [],
        },
        {
          id: 'd1',
          kind: 'dm',
          name: null,
          created_at: '2026-01-05T00:00:00Z',
          archived_at: null,
          members: [{ user_id: 'u1' }, { user_id: 'u2' }],
          internal_messages: [],
        },
      ],
      error: null,
    },
    profiles: {
      data: [
        { user_id: 'u1', full_name: 'Sara' },
        { user_id: 'u2', full_name: 'Omar' },
        { user_id: ME, full_name: 'Me' },
      ],
      error: null,
    },
  };
});

describe('GET /api/chat/admin/private-channels', () => {
  it('lists the private channels and DMs the admin is not in', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      channels: [
        {
          id: 'p1',
          kind: 'private',
          name: 'Ops',
          memberNames: ['Omar', 'Sara'],
          memberCount: 2,
          lastActivityAt: '2026-02-01T00:00:00Z',
          archived: false,
        },
        {
          id: 'd1',
          kind: 'dm',
          name: null,
          memberNames: ['Omar', 'Sara'],
          memberCount: 2,
          lastActivityAt: '2026-01-05T00:00:00Z',
          archived: false,
        },
      ],
    });
  });

  it('reads only the caller workspace, and only the kinds an admin may read', async () => {
    await GET();
    const of = (table: string, op: string) =>
      mocks.calls.filter((c) => c.table === table && c.op === op);
    expect(of('chat_channels', 'eq')).toContainEqual({
      table: 'chat_channels',
      op: 'eq',
      args: ['account_id', WS],
    });
    expect(of('chat_channels', 'in')[0].args).toEqual([
      'kind',
      ['private', 'dm', 'deal_room'],
    ]);
    expect(of('profiles', 'eq')[0].args).toEqual(['account_id', WS]);
  });

  it('names the foreign key of the messages embed (message_pins makes it ambiguous)', async () => {
    await GET();
    const select = mocks.calls.find(
      (c) => c.table === 'chat_channels' && c.op === 'select'
    )?.args[0];
    expect(select).toContain(
      'internal_messages!internal_messages_channel_id_fkey(created_at)'
    );
  });

  it('lets an owner in too', async () => {
    mocks.caller.role = 'owner';
    expect((await GET()).status).toBe(200);
  });

  it.each(['team_leader', 'agent', 'viewer', 'bank_guest'])(
    'refuses a %s without touching the service role',
    async (role) => {
      mocks.caller.role = role;
      const res = await GET();
      expect(res.status).toBe(403);
      expect(mocks.calls).toEqual([]);
    }
  );

  it('refuses a caller with no session', async () => {
    mocks.caller.signedIn = false;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mocks.calls).toEqual([]);
  });

  it('answers 500 when a read fails', async () => {
    mocks.results.profiles = { data: null, error: { message: 'boom' } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to load private channels',
    });
  });
});
