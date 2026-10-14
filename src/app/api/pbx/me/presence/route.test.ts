import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

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

import { PbxConnectionError } from '@/lib/pbx/connection';
import { YeastarError } from '@/lib/pbx/yeastar';
import { PUT } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
let rls: FakeDb;
let service: FakeDb;
const findExtension = vi.fn();
const setPresence = vi.fn();

function as(role: string, mapped = true) {
  rls = createFakeDb(
    {},
    {
      pbx_my_extension: () => ({
        data: mapped
          ? [
              {
                connection_id: 'conn-1',
                extension: '201',
                softphone_enabled: false,
              },
            ]
          : [],
        error: null,
      }),
    }
  );
  mocks.requireRole.mockImplementation(async (min: string) => {
    if (role === 'viewer' && min === 'agent') throw new Error('Forbidden');
    return { accountId: A, userId: 'user-1', role, supabase: rls.db };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  service = createFakeDb({
    pbx_extensions: [
      {
        connection_id: 'conn-1',
        extension: '201',
        account_id: A,
        user_id: 'user-1',
        presence_monitor: true,
      },
    ],
    pbx_presence: [],
  });
  mocks.service = service.db;
  findExtension.mockImplementation(async (number: string) =>
    number === '201' ? { id: 238, number } : { id: 999, number }
  );
  setPresence.mockResolvedValue(undefined);
  mocks.pbxApiFor.mockResolvedValue({ api: { findExtension, setPresence } });
  as('agent');
});

const put = (body: unknown) =>
  PUT(
    new Request('https://crm.example.com/api/pbx/me/presence', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

describe('PUT /api/pbx/me/presence', () => {
  it('needs an agent', async () => {
    as('viewer');
    expect((await put({ status: 'away' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(setPresence).not.toHaveBeenCalled();
  });

  it('takes only one of the six Yeastar statuses', async () => {
    for (const body of [
      {},
      { status: 'lunch_break' },
      { status: 'dnd' },
      { status: 1 },
      [],
    ])
      expect((await put(body)).status).toBe(400);
    expect(setPresence).not.toHaveBeenCalled();
  });

  it('refuses a caller with no extension', async () => {
    as('agent', false);
    const res = await put({ status: 'away' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_extension');
    expect(setPresence).not.toHaveBeenCalled();
  });

  it('sets the caller’s own extension, whatever the body says', async () => {
    const res = await put({
      status: 'do_not_disturb',
      extension: '999',
      id: 999,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'do_not_disturb' });
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    expect(findExtension).toHaveBeenCalledWith('201');
    expect(setPresence).toHaveBeenCalledWith({
      id: 238,
      status: 'do_not_disturb',
    });
    expect(service.tables.pbx_presence).toEqual([
      expect.objectContaining({
        connection_id: 'conn-1',
        extension: '201',
        account_id: A,
        user_id: 'user-1',
        presence: 'do_not_disturb',
      }),
    ]);
  });

  it('keeps no presence row while presence_monitor is off', async () => {
    service.tables.pbx_extensions[0].presence_monitor = false;
    service.tables.pbx_presence = [
      { connection_id: 'conn-1', extension: '201', presence: 'away' },
    ];
    expect((await put({ status: 'lunch' })).status).toBe(200);
    expect(setPresence).toHaveBeenCalledWith({ id: 238, status: 'lunch' });
    expect(service.tables.pbx_presence).toEqual([]);
  });

  it('answers 409 when the PBX does not list the extension', async () => {
    findExtension.mockResolvedValue(null);
    const res = await put({ status: 'away' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('extension_not_on_pbx');
    expect(setPresence).not.toHaveBeenCalled();
  });

  it('maps the phone system’s failures', async () => {
    setPresence.mockRejectedValue(
      new YeastarError({
        endpoint: 'extension/update',
        errcode: 10002,
        errmsg: 'FAILURE',
      })
    );
    let res = await put({ status: 'away' });
    expect(res.status).toBe(502);
    expect(service.tables.pbx_presence).toEqual([]);
    mocks.pbxApiFor.mockRejectedValue(
      new PbxConnectionError('not_found', 'gone')
    );
    res = await put({ status: 'away' });
    expect(res.status).toBe(503);
  });
});
