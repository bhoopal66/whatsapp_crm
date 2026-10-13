import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

// Admin+. The five audit tables are read with the caller's own client,
// each filtered to the active account, then merged newest first and
// paged by 50; actor and item names come from the account's rows, and a
// removed member's from the name the workspace log recorded.

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALL = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const GONE = '55555555-5555-4555-8555-555555555555';
const KEPT = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  caller: { role: 'admin' as string },
  data: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { table: string; op: string; args: unknown[] }[],
}));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'gte', 'lt', 'order', 'limit'])
    b[op] = (...args: unknown[]) => {
      mocks.calls.push({ table, op, args });
      return b;
    };
  b.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: mocks.data[table] ?? [], error: null }).then(ok);
  return b;
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (min: AccountRole) => {
    if (!hasMinRole(mocks.caller.role as AccountRole, min))
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    return {
      supabase: { from: builder },
      userId: ME,
      accountId: WS,
      role: mocks.caller.role,
      account: { id: WS, name: 'WS' },
    };
  },
  toErrorResponse: (err: { status?: number; message: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

import { GET } from './route';

const get = (qs = '') => GET(new Request(`http://x/api/audit${qs}`));
const at = (minute: number) =>
  `2026-10-01T09:${String(minute).padStart(2, '0')}:00+00:00`;

beforeEach(() => {
  mocks.caller.role = 'admin';
  mocks.calls.length = 0;
  mocks.data = {
    chat_audit_log: [
      {
        id: 'c1',
        actor_id: ME,
        action: 'admin_read_private',
        at: at(5),
        detail: { reason: 'Complaint' },
      },
    ],
    call_access_log: [
      { id: 9, call_id: CALL, user_id: ME, action: 'play', at: at(7) },
    ],
    pbx_audit: [
      {
        id: 2,
        actor_id: ME,
        action: 'erase_contact_calls',
        contact_id: CONTACT,
        call_ids: [CALL],
        reason: 'GDPR',
        detail: { recordings: 1 },
        at: at(1),
      },
    ],
    deal_room_audit: [],
    workspace_audit: [],
    profiles: [{ user_id: ME, full_name: 'Amina Admin' }],
    calls: [{ id: CALL, remote_number: '+971500000000', contact_id: CONTACT }],
    contacts: [{ id: CONTACT, name: 'Rashid', phone: '+971500000000' }],
  };
});

describe('GET /api/audit', () => {
  it.each(['team_leader', 'agent', 'viewer'])('refuses a %s', async (role) => {
    mocks.caller.role = role;
    expect((await get()).status).toBe(403);
    expect(mocks.calls).toEqual([]);
  });

  it('merges the sources newest first, names people and items', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: { key: string }) => r.key)).toEqual([
      'recordings:9',
      'team_chat:c1',
      'phone:2',
    ]);
    expect(body.rows.map((r: { actorName: string }) => r.actorName)).toEqual([
      'Amina Admin',
      'Amina Admin',
      'Amina Admin',
    ]);
    expect(body.rows[0].itemLabel).toBe('Rashid');
    expect(body.rows[2]).toMatchObject({ itemLabel: 'Rashid', reason: 'GDPR' });
    expect(body.hasMore).toBe(false);
    for (const table of [
      'chat_audit_log',
      'call_access_log',
      'pbx_audit',
      'deal_room_audit',
      'workspace_audit',
    ]) {
      expect(mocks.calls).toContainEqual({
        table,
        op: 'eq',
        args: ['account_id', WS],
      });
      expect(mocks.calls).toContainEqual({ table, op: 'limit', args: [51] });
    }
  });

  it('names a removed member from the log, a current one from the profile', async () => {
    mocks.data.workspace_audit = [
      {
        id: 'w1',
        actor_id: ME,
        action: 'member_removed',
        target_user_id: GONE,
        detail: { role: 'agent', name: 'Omar Left' },
        at: at(9),
      },
      {
        id: 'w2',
        actor_id: null,
        action: 'member_added',
        target_user_id: KEPT,
        detail: { role: 'viewer', name: 'Old spelling' },
        at: at(8),
      },
      {
        id: 'w3',
        actor_id: GONE,
        action: 'member_removed',
        target_user_id: GONE,
        detail: { role: 'agent', name: '' },
        at: at(6),
      },
    ];
    mocks.data.profiles = [
      { user_id: ME, full_name: 'Amina Admin' },
      { user_id: KEPT, full_name: 'Kamal Kept' },
    ];
    const body = await (await get('?source=workspace')).json();
    expect(
      body.rows.map((r: Record<string, unknown>) => [
        r.key,
        r.actorName,
        r.itemLabel,
        r.facts,
      ])
    ).toEqual([
      [
        'workspace:w1',
        'Amina Admin',
        'Omar Left',
        [{ key: 'role', from: null, to: 'agent' }],
      ],
      [
        'workspace:w2',
        null,
        'Kamal Kept',
        [{ key: 'role', from: null, to: 'viewer' }],
      ],
      ['workspace:w3', null, null, [{ key: 'role', from: null, to: 'agent' }]],
    ]);
    expect(body.rows[1].actorId).toBeNull();
    expect(mocks.calls).toContainEqual({
      table: 'profiles',
      op: 'eq',
      args: ['account_id', WS],
    });
  });

  it('pages by 50 and says whether more follow', async () => {
    mocks.data.call_access_log = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      call_id: CALL,
      user_id: ME,
      action: 'play',
      at: at(59 - i),
    }));
    const first = await (await get()).json();
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await (await get('?page=2')).json();
    expect(second.rows).toHaveLength(12);
    expect(second.hasMore).toBe(false);
    expect(mocks.calls).toContainEqual({
      table: 'pbx_audit',
      op: 'limit',
      args: [101],
    });
  });

  it('applies the filters to the chosen source only', async () => {
    const res = await get(
      `?source=recordings&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&actor=${ME}`
    );
    expect(res.status).toBe(200);
    const read = new Set(
      mocks.calls.filter((c) => c.op === 'order').map((c) => c.table)
    );
    expect([...read]).toEqual(['call_access_log']);
    expect(mocks.calls).toEqual(
      expect.arrayContaining([
        { table: 'call_access_log', op: 'eq', args: ['user_id', ME] },
        {
          table: 'call_access_log',
          op: 'gte',
          args: ['at', '2026-10-01T00:00:00.000Z'],
        },
        {
          table: 'call_access_log',
          op: 'lt',
          args: ['at', '2026-10-02T00:00:00.000Z'],
        },
      ])
    );
  });

  it('answers a bad filter with 400', async () => {
    expect((await get('?source=calls')).status).toBe(400);
    expect((await get('?page=99')).status).toBe(400);
  });
});
