import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import type { CallInfo, CallMember } from '@/lib/pbx/yeastar';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
  pbxApiFor: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.service,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: mocks.pbxApiFor,
}));

import { POST } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const OTHER_ACCOUNT = '00000000-0000-4000-8000-00000000000b';
const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
const C3 = '00000000-0000-4000-8000-000000000003';

const ext = (number: string, channelId: string, status = 'ANSWERED') =>
  ({ kind: 'extension', number, channelId, status }) as CallMember;
const trunk = (channelId: string, status = 'ANSWERED') =>
  ({ kind: 'inbound', channelId, status, from: '971501234567' }) as CallMember;

/** What the PBX has live: the caller (201) is on pbx-1 only. */
const LIVE: CallInfo[] = [
  { callId: 'pbx-1', members: [ext('201', 'ch-201'), trunk('ch-cust')] },
  { callId: 'pbx-2', members: [ext('202', 'ch-202'), trunk('ch-other')] },
  // 201 transferred this customer to 203 and left the call.
  {
    callId: 'pbx-3',
    members: [
      ext('201', 'ch-201-old', 'BYE'),
      ext('203', 'ch-203'),
      trunk('ch-x'),
    ],
  },
];
const api = {
  // As the PBX: by extension, the calls it is a member of; by id, the call.
  queryCalls: vi.fn(async (q: { extension?: string; callId?: string }) =>
    LIVE.filter((c) =>
      q.callId !== undefined
        ? c.callId === q.callId
        : c.members.some((m) => m.number === q.extension)
    )
  ),
  hangup: vi.fn(),
  hold: vi.fn(),
  unhold: vi.fn(),
  mute: vi.fn(),
  unmute: vi.fn(),
  transfer: vi.fn(),
};
const ACTS = [
  'hangup',
  'hold',
  'unhold',
  'mute',
  'unmute',
  'transfer',
] as const;
let rls: FakeDb;
let service: FakeDb;

function as(
  role: string,
  extension = '201',
  visible = [{ id: C1, phone: '971501234567' }]
) {
  rls = createFakeDb(
    {
      contacts: visible.map((c) => ({
        ...c,
        account_id: A,
        do_not_contact_at: null,
      })),
    },
    {
      pbx_my_extension: () => ({
        data: [{ connection_id: 'conn-1', extension, softphone_enabled: true }],
        error: null,
      }),
    }
  );
  mocks.requireRole.mockResolvedValue({
    accountId: A,
    userId: 'user-1',
    role,
    supabase: rls.db,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  service = createFakeDb({
    calls: [
      {
        account_id: A,
        connection_id: 'conn-1',
        pbx_call_id: 'pbx-1',
        contact_id: C1,
      },
    ],
    call_live: [],
    contacts: [
      {
        id: C1,
        account_id: A,
        user_id: 'owner-9',
        phone: '971501234567',
        do_not_contact_at: null,
      },
      {
        id: C2,
        account_id: A,
        user_id: 'owner-8',
        phone: '971502222222',
        do_not_contact_at: null,
      },
      {
        id: C3,
        account_id: A,
        user_id: null,
        phone: '971503333333',
        do_not_contact_at: '2026-10-01T00:00:00Z',
        do_not_contact_reason: 'Asked',
      },
    ],
    pbx_extensions: [
      {
        account_id: OTHER_ACCOUNT,
        connection_id: 'conn-1',
        user_id: 'owner-9',
        extension: '299',
      },
      {
        account_id: A,
        connection_id: 'conn-2',
        user_id: 'owner-9',
        extension: '298',
      },
      {
        account_id: A,
        connection_id: 'conn-1',
        user_id: 'owner-9',
        extension: '209',
      },
      {
        account_id: A,
        connection_id: 'conn-1',
        user_id: 'user-1',
        extension: '201',
      },
    ],
  });
  mocks.service = service.db;
  mocks.pbxApiFor.mockResolvedValue({ api });
  as('agent');
});

const post = (pbxCallId: string, action: string, body?: unknown) =>
  POST(
    new Request(
      `https://crm.example.com/api/pbx/calls/${pbxCallId}/${action}`,
      {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ id: pbxCallId, action }) }
  );
const acted = () => ACTS.filter((a) => api[a].mock.calls.length > 0);

describe('POST /api/pbx/calls/[pbxCallId]/[action]', () => {
  it('needs an agent and a known action', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await post('pbx-1', 'hangup')).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    as('agent');
    expect((await post('pbx-1', 'record')).status).toBe(404);
    expect(api.queryCalls).not.toHaveBeenCalled();
  });

  it('refuses a caller with no extension', async () => {
    rls.rpcs.pbx_my_extension = () => ({ data: [], error: null });
    expect((await post('pbx-1', 'hangup')).status).toBe(409);
    expect(acted()).toEqual([]);
  });

  it.each(['hangup', 'hold', 'unhold', 'mute', 'unmute'] as const)(
    '%s acts on the caller’s own channel',
    async (action) => {
      const res = await post('pbx-1', action);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(api.queryCalls).toHaveBeenCalledWith({ extension: '201' });
      expect(api[action]).toHaveBeenCalledWith({ channelId: 'ch-201' });
      expect(acted()).toEqual([action]);
    }
  );

  it('refuses another user’s call, whatever the role', async () => {
    for (const role of ['agent', 'team_leader', 'admin', 'owner']) {
      as(role);
      for (const action of ACTS) {
        const res = await post('pbx-2', action, { number: '205' });
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_on_call');
      }
    }
    expect(acted()).toEqual([]);
  });

  it('refuses a call the caller has left', async () => {
    for (const action of ACTS)
      expect((await post('pbx-3', action, { toOwner: true })).status).toBe(404);
    expect(acted()).toEqual([]);
  });

  it('blind-transfers the other party to an extension', async () => {
    const res = await post('pbx-1', 'transfer', { number: '205' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: '205' });
    expect(api.transfer).toHaveBeenCalledWith({
      type: 'blind',
      channelId: 'ch-cust',
      number: '205',
    });
  });

  it('transfers to the owner of the call’s customer on the same PBX', async () => {
    const res = await post('pbx-1', 'transfer', { toOwner: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: '209' });
    expect(api.transfer).toHaveBeenCalledWith({
      type: 'blind',
      channelId: 'ch-cust',
      number: '209',
    });
  });

  it('follows a re-linked customer, else the screen pop', async () => {
    service.tables.calls[0].contact_id = C2;
    service.tables.pbx_extensions.push({
      account_id: A,
      connection_id: 'conn-1',
      user_id: 'owner-8',
      extension: '208',
    });
    expect(
      (await (await post('pbx-1', 'transfer', { toOwner: true })).json()).number
    ).toBe('208');
    service.tables.calls = [];
    service.tables.call_live = [
      {
        account_id: A,
        connection_id: 'conn-1',
        pbx_call_id: 'pbx-1',
        contact_id: C1,
      },
    ];
    expect(
      (await (await post('pbx-1', 'transfer', { toOwner: true })).json()).number
    ).toBe('209');
  });

  it('refuses to transfer to an owner it cannot find', async () => {
    service.tables.pbx_extensions = service.tables.pbx_extensions.filter(
      (e) => e.extension !== '209'
    );
    let res = await post('pbx-1', 'transfer', { toOwner: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('owner_no_extension');
    service.tables.calls[0].contact_id = C3;
    res = await post('pbx-1', 'transfer', { toOwner: true });
    expect((await res.json()).code).toBe('no_owner');
    service.tables.calls[0].contact_id = null;
    res = await post('pbx-1', 'transfer', { toOwner: true });
    expect((await res.json()).code).toBe('no_contact');
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('holds an outside number to the dial rules', async () => {
    const dnc = await post('pbx-1', 'transfer', { number: '050 333 3333' });
    expect(dnc.status).toBe(409);
    expect((await dnc.json()).code).toBe('do_not_contact');
    expect(api.transfer).not.toHaveBeenCalled();
    expect(
      (await post('pbx-1', 'transfer', { number: '+44 20 7946 0000' })).status
    ).toBe(200);
    expect(api.transfer).toHaveBeenCalledWith({
      type: 'blind',
      channelId: 'ch-cust',
      number: '442079460000',
    });
    expect(
      (await post('pbx-1', 'transfer', { number: '050 123 4567' })).status
    ).toBe(200);
    expect(api.transfer).toHaveBeenLastCalledWith({
      type: 'blind',
      channelId: 'ch-cust',
      number: '971501234567',
    });
  });

  it('validates the transfer body', async () => {
    for (const body of [
      {},
      { number: '205', toOwner: true },
      { number: 205 },
      { toOwner: 'yes' },
      [],
    ])
      expect((await post('pbx-1', 'transfer', body)).status).toBe(400);
    expect((await post('pbx-1', 'transfer', { number: '201' })).status).toBe(
      409
    );
    expect(api.transfer).not.toHaveBeenCalled();
  });
});
