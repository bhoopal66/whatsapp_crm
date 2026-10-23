import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YeastarError } from '@/lib/pbx/yeastar';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  db: null as unknown,
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
  pbxServiceDb: () => mocks.db,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: mocks.pbxApiFor,
}));

import { GET } from './route';
import { POST as SYNC } from './sync/route';
import { PATCH } from './[id]/route';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const [A1, A2, A3] = [id(1), id(2), id(3)];
const [U1, U2, U3, U4] = [id(5), id(6), id(7), id(8)];
const offline = {
  sipPhone: false,
  linkusDesktop: false,
  linkusMobile: false,
  linkusWeb: false,
};
let fake: FakeDb;
const ext = (n: string) =>
  fake.tables.pbx_extensions.find((r) => r.extension === n)!;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createFakeDb(
    {
      pbx_connections: [{ id: 'c1', account_id: A1, created_at: '1' }],
      pbx_connection_secrets: [{ connection_id: 'c1' }],
      pbx_extensions: [
        {
          id: 'e1',
          connection_id: 'c1',
          extension: '1001',
          account_id: A2,
          user_id: U2,
          softphone_enabled: true,
          registration_state: 'unregistered',
        },
        {
          id: 'e2',
          connection_id: 'c1',
          extension: '1002',
          account_id: A1,
          user_id: null,
        },
        {
          id: 'e3',
          connection_id: 'c1',
          extension: '1003',
          account_id: A3,
          user_id: U4,
        },
        {
          id: 'e9',
          connection_id: 'c2',
          extension: '1009',
          account_id: A1,
          user_id: null,
        },
      ],
      profiles: [
        {
          user_id: U1,
          account_id: A1,
          account_role: 'agent',
          full_name: 'Ann',
        },
        {
          user_id: U2,
          account_id: A2,
          account_role: 'agent',
          full_name: 'Bob',
        },
        {
          user_id: U3,
          account_id: A2,
          account_role: 'viewer',
          full_name: 'Vic',
        },
        { user_id: U4, account_id: A3, account_role: 'agent', full_name: 'Cy' },
      ],
    },
    {
      my_workspaces: () => ({
        data: [
          {
            account_id: A1,
            name: 'One',
            role: 'admin',
            is_active: true,
            deactivated: false,
          },
          {
            account_id: A2,
            name: 'Two',
            role: 'owner',
            is_active: false,
            deactivated: false,
          },
          {
            account_id: A3,
            name: 'Three',
            role: 'agent',
            is_active: false,
            deactivated: false,
          },
        ],
        error: null,
      }),
    }
  );
  mocks.db = fake.db;
  mocks.requireRole.mockResolvedValue({
    accountId: A1,
    userId: 'admin-1',
    role: 'admin',
    supabase: fake.db,
  });
});

const patch = (extId: string, body: unknown) =>
  PATCH(
    new Request('https://crm.example.com/api/pbx/extensions/x', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: extId }) }
  );

describe('GET /api/pbx/extensions', () => {
  it('requires an admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await GET()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it("lists the connection's extensions, naming people only where the caller is admin", async () => {
    const body = await (await GET()).json();
    expect(body.extensions.map((e: { id: string }) => e.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    expect(body.extensions[0]).toMatchObject({
      accountId: A2,
      userId: U2,
      personName: 'Bob',
      mapped: true,
      softphoneEnabled: true,
    });
    expect(body.extensions[2]).toMatchObject({
      accountId: A3,
      userId: null,
      personName: null,
      mapped: true,
    });
    expect(body.workspaces).toEqual([
      { accountId: A1, name: 'One', people: [{ userId: U1, name: 'Ann' }] },
      { accountId: A2, name: 'Two', people: [{ userId: U2, name: 'Bob' }] },
    ]);
  });
});

describe('POST /api/pbx/extensions/sync', () => {
  it('pages through the PBX, refreshes registration only and inserts new extensions unmapped', async () => {
    const listExtensions = vi.fn(async ({ page }: { page: number }) => ({
      total: 101,
      items:
        page === 1
          ? [
              {
                number: '1001',
                callerIdName: 'Desk',
                online: { ...offline, sipPhone: true },
              },
            ]
          : [{ number: '1004', callerIdName: 'New', online: offline }],
    }));
    mocks.pbxApiFor.mockResolvedValue({ api: { listExtensions } });
    const res = await SYNC();
    expect(res.status).toBe(200);
    expect(listExtensions).toHaveBeenCalledTimes(2);
    expect(ext('1001')).toMatchObject({
      account_id: A2,
      user_id: U2,
      softphone_enabled: true,
      registration_state: 'registered',
      client_kind: 'sip',
    });
    expect(ext('1004')).toMatchObject({
      connection_id: 'c1',
      account_id: A1,
      registration_state: 'unregistered',
      client_kind: null,
    });
    expect(ext('1004').user_id ?? null).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ total: 2, added: 1 });
    expect(
      body.extensions.find((e: { extension: string }) => e.extension === '1001')
    ).toMatchObject({ onPbx: true, callerIdName: 'Desk', userId: U2 });
    expect(
      body.extensions.find((e: { extension: string }) => e.extension === '1002')
        .onPbx
    ).toBe(false);
    const writes = fake.log.filter(
      (l) => l.table === 'pbx_extensions' && l.op === 'update'
    );
    for (const w of writes)
      expect(Object.keys(w.payload as object).sort()).toEqual([
        'client_kind',
        'registration_state',
        'updated_at',
      ]);
  });

  it("refreshes every known extension, past PostgREST's 1,000-row read cap", async () => {
    const numbers = Array.from({ length: 1200 }, (_, i) => String(2000 + i));
    fake.tables.pbx_extensions.push(
      ...numbers.map((extension) => ({
        id: `x${extension}`,
        connection_id: 'c1',
        extension,
        account_id: A1,
        user_id: null,
        registration_state: 'unregistered',
      }))
    );
    fake.capRows(1000);
    const listExtensions = vi.fn(
      async ({ page, pageSize }: { page: number; pageSize: number }) => ({
        total: numbers.length,
        items: numbers
          .slice((page - 1) * pageSize, page * pageSize)
          .map((number) => ({
            number,
            callerIdName: '',
            online: { ...offline, sipPhone: true },
          })),
      })
    );
    mocks.pbxApiFor.mockResolvedValue({ api: { listExtensions } });
    const res = await SYNC();
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(0);
    expect(
      numbers.filter((n) => ext(n).registration_state !== 'registered')
    ).toEqual([]);
  });

  it('logs in once on a refused credential and backs every process off', async () => {
    const listExtensions = vi.fn(async () => {
      throw new YeastarError({
        endpoint: 'get_token',
        errcode: -1,
        errmsg: 'FAILURE',
      });
    });
    mocks.pbxApiFor.mockResolvedValue({ api: { listExtensions } });
    expect((await SYNC()).status).toBe(502);
    expect(listExtensions).toHaveBeenCalledTimes(1);
    expect(fake.tables.pbx_connections[0].status).toBe('auth_failed');
    expect(
      Date.parse(String(fake.tables.pbx_connection_secrets[0].backoff_until))
    ).toBeGreaterThan(Date.now());
  });
});

describe('PATCH /api/pbx/extensions/[id]', () => {
  it('maps an extension to a staff member of a workspace the caller administers', async () => {
    const res = await patch('e2', {
      userId: U2,
      accountId: A2,
      softphoneEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(ext('1002')).toMatchObject({
      account_id: A2,
      user_id: U2,
      softphone_enabled: true,
    });
    expect((await res.json()).extension).toMatchObject({ personName: 'Bob' });
  });

  it('refuses a workspace where the caller is not an owner or admin', async () => {
    const res = await patch('e2', { userId: U4, accountId: A3 });
    expect(res.status).toBe(403);
    expect(ext('1002')).toMatchObject({ account_id: A1, user_id: null });
    expect((await patch('e3', { softphoneEnabled: true })).status).toBe(403);
  });

  it('refuses a viewer, or a person of another workspace', async () => {
    expect((await patch('e2', { userId: U3, accountId: A2 })).status).toBe(400);
    expect((await patch('e2', { userId: U2 })).status).toBe(400);
    expect((await patch('e1', { accountId: A1 })).status).toBe(400);
    expect(ext('1002').user_id).toBeNull();
  });

  it('answers 409 for a second extension of one person in a workspace', async () => {
    fake.fail('pbx_extensions', 'update', { code: '23505', message: 'dup' });
    const res = await patch('e2', { userId: U1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(
      /already has an extension in this workspace/
    );
  });

  it('validates the body and finds only its own connection', async () => {
    expect((await patch('e2', {})).status).toBe(400);
    expect((await patch('e2', { userId: 'nope' })).status).toBe(400);
    expect((await patch('e2', { presenceMonitor: 'yes' })).status).toBe(400);
    expect((await patch('e9', { userId: U1 })).status).toBe(404);
  });
});
