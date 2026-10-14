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
import { POST } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
let rls: FakeDb;
let service: FakeDb;
const api = {
  listQueues: vi.fn(),
  findExtension: vi.fn(),
  agentLogin: vi.fn(),
  agentPause: vi.fn(),
  managerAgentLogin: vi.fn(),
  managerAgentPause: vi.fn(),
};
const actions = [
  api.agentLogin,
  api.agentPause,
  api.managerAgentLogin,
  api.managerAgentPause,
];

function as(role: string, mapped = true) {
  rls = createFakeDb(
    {
      pbx_extensions: [
        { connection_id: 'conn-1', extension: '201', user_id: 'user-1' },
        { connection_id: 'conn-1', extension: '202', user_id: 'user-2' },
        { connection_id: 'conn-1', extension: '203', user_id: 'user-3' },
        { connection_id: 'conn-1', extension: '204', user_id: 'user-4' },
        { connection_id: 'conn-1', extension: '209', user_id: null },
      ].map((r) => ({ ...r, account_id: A })),
      profiles: [],
    },
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
    pbx_connections: [
      { id: 'conn-1', account_id: A, created_at: '2026-01-01T00:00:00Z' },
    ],
  });
  mocks.service = service.db;
  api.listQueues.mockResolvedValue([
    {
      id: 7,
      number: '6407',
      name: 'Support',
      strategy: 'ring_all',
      dynamicAgents: [
        { extId: 101, number: '201', name: 'A' },
        { extId: 102, number: '202', name: 'B' },
        { number: '204', name: 'D' },
        { extId: 109, number: '209', name: 'X' },
      ],
      staticAgents: [{ extId: 103, number: '203', name: 'C' }],
    },
  ]);
  api.findExtension.mockResolvedValue({ id: 104, number: '204' });
  for (const f of actions) f.mockResolvedValue(undefined);
  mocks.pbxApiFor.mockResolvedValue({ api });
  as('agent');
});

const post = (body: unknown, id = '7') =>
  POST(
    new Request(`https://crm.example.com/api/pbx/queues/${id}/agent`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
const code = async (res: Response) => (await res.json()).code;
const nothingSent = () => {
  for (const f of actions) expect(f).not.toHaveBeenCalled();
};

describe('POST /api/pbx/queues/[id]/agent', () => {
  it('needs an agent', async () => {
    as('viewer');
    expect((await post({ action: 'login' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    nothingSent();
  });

  it('checks the body and the queue id', async () => {
    for (const body of [
      {},
      { action: 'logon' },
      { action: 'pause', extension: '' },
      { action: 'pause', extension: 202 },
      [],
    ])
      expect((await post(body)).status).toBe(400);
    for (const id of ['0', 'abc', '-1', '7.5'])
      expect((await post({ action: 'pause' }, id)).status).toBe(400);
    nothingSent();
  });

  it('refuses a caller with no extension acting on themselves', async () => {
    as('team_leader', false);
    const res = await post({ action: 'login' });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('no_extension');
    nothingSent();
  });

  it('acts on the caller’s own extension, for this queue only', async () => {
    let res = await post({ action: 'login' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    expect(api.agentLogin).toHaveBeenCalledWith({
      extId: 101,
      operation: 'login',
      queueIds: [7],
    });
    res = await post({ action: 'unpause', extension: '201' });
    expect(res.status).toBe(200);
    expect(api.agentPause).toHaveBeenCalledWith({
      extId: 101,
      operation: 'unpause',
      queueIds: [7],
    });
    expect(api.managerAgentLogin).not.toHaveBeenCalled();
    expect(api.managerAgentPause).not.toHaveBeenCalled();
  });

  it('refuses an agent acting on someone else', async () => {
    const res = await post({ action: 'logout', extension: '202' });
    expect(res.status).toBe(403);
    expect(api.listQueues).not.toHaveBeenCalled();
    nothingSent();
  });

  it('lets a team leader act on another agent of the workspace', async () => {
    as('team_leader');
    let res = await post({ action: 'logout', extension: '202' });
    expect(res.status).toBe(200);
    expect(api.managerAgentLogin).toHaveBeenCalledWith({
      extIds: [102],
      queueId: 7,
      operation: 'logout',
    });
    res = await post({ action: 'pause', extension: '203' });
    expect(res.status).toBe(200);
    expect(api.managerAgentPause).toHaveBeenCalledWith({
      extIds: [103],
      queueId: 7,
      operation: 'pause',
    });
    expect(api.agentLogin).not.toHaveBeenCalled();
    expect(api.agentPause).not.toHaveBeenCalled();
  });

  it('uses the workspace’s PBX for a leader with no extension', async () => {
    as('admin', false);
    const res = await post({ action: 'login', extension: '204' });
    expect(res.status).toBe(200);
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    expect(api.findExtension).toHaveBeenCalledWith('204');
    expect(api.managerAgentLogin).toHaveBeenCalledWith({
      extIds: [104],
      queueId: 7,
      operation: 'login',
    });
  });

  it('answers 404 for an extension not mapped in the workspace', async () => {
    as('team_leader');
    for (const extension of ['209', '555']) {
      const res = await post({ action: 'pause', extension });
      expect(res.status).toBe(404);
      expect(await code(res)).toBe('extension_not_found');
    }
    expect(api.listQueues).not.toHaveBeenCalled();
    nothingSent();
  });

  it('answers 404 for a queue the PBX does not have', async () => {
    const res = await post({ action: 'pause' }, '8');
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('queue_not_found');
    nothingSent();
  });

  it('answers 409 for an extension that is not in the queue', async () => {
    as('team_leader');
    api.listQueues.mockResolvedValue([
      {
        id: 7,
        number: '6407',
        name: 'S',
        strategy: '',
        dynamicAgents: [],
        staticAgents: [],
      },
    ]);
    let res = await post({ action: 'pause', extension: '202' });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_in_queue');
    res = await post({ action: 'pause' });
    expect(await code(res)).toBe('not_in_queue');
    nothingSent();
  });

  it('never logs a static agent in or out, but pauses one', async () => {
    as('team_leader');
    for (const action of ['login', 'logout']) {
      const res = await post({ action, extension: '203' });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('static_agent');
    }
    nothingSent();
    expect((await post({ action: 'unpause', extension: '203' })).status).toBe(
      200
    );
  });

  it('answers 409 when the PBX does not list the extension', async () => {
    as('team_leader');
    api.findExtension.mockResolvedValue(null);
    const res = await post({ action: 'pause', extension: '204' });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('extension_not_on_pbx');
    nothingSent();
  });

  it('maps the phone system’s failures', async () => {
    api.agentPause.mockRejectedValue(
      new YeastarError({
        endpoint: 'agent/pause',
        errcode: 10002,
        errmsg: 'FAILURE',
      })
    );
    expect((await post({ action: 'pause' })).status).toBe(502);
    mocks.pbxApiFor.mockRejectedValue(
      new PbxConnectionError('not_found', 'gone')
    );
    expect((await post({ action: 'pause' })).status).toBe(503);
  });
});
