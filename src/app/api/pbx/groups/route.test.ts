import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import type { QueueInfo, RingGroup } from '@/lib/pbx/yeastar/api';

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

import { YeastarError } from '@/lib/pbx/yeastar';
import { GET } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
let rls: FakeDb;
let service: FakeDb;
const listRingGroups = vi.fn();
const listQueues = vi.fn();
const queueAgentStatus = vi.fn();

const mappings = [
  { connection_id: 'conn-1', extension: '201', user_id: 'user-1' },
  { connection_id: 'conn-1', extension: '202', user_id: 'user-2' },
  { connection_id: 'conn-1', extension: '209', user_id: null },
  { connection_id: 'conn-2', extension: '301', user_id: 'user-3' },
];

function as(role: string, mapped = true) {
  rls = createFakeDb(
    {
      pbx_extensions: mappings.map((m) => ({ ...m, account_id: A })),
      profiles: [
        { user_id: 'user-1', account_id: A, full_name: 'Amal' },
        { user_id: 'user-2', account_id: A, full_name: 'Badr' },
        { user_id: 'user-2', account_id: 'other', full_name: 'Elsewhere' },
      ],
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

const agent = (number: string, extId?: number) => ({
  number,
  name: `PBX ${number}`,
  ...(extId ? { extId } : {}),
});
const queue = (
  id: number,
  dynamic: string[],
  stat: string[] = []
): QueueInfo => ({
  id,
  number: String(6400 + id),
  name: `Queue ${id}`,
  strategy: 'ring_all',
  dynamicAgents: dynamic.map((n) => agent(n)),
  staticAgents: stat.map((n) => agent(n)),
});

beforeEach(() => {
  vi.clearAllMocks();
  service = createFakeDb({
    pbx_connections: [
      { id: 'conn-1', account_id: A, created_at: '2026-01-01T00:00:00Z' },
    ],
  });
  mocks.service = service.db;
  const groups: RingGroup[] = [
    {
      id: 1,
      number: '6300',
      name: 'Sales',
      strategy: 'ring_all',
      members: [
        { number: '201', name: 'PBX 201' },
        { number: '250', name: 'PBX 250' },
      ],
    },
    {
      id: 2,
      number: '6301',
      name: 'Elsewhere',
      strategy: 'sequentially',
      members: [
        { number: '209', name: 'PBX 209' },
        { number: '301', name: 'PBX 301' },
      ],
    },
  ];
  listRingGroups.mockResolvedValue(groups);
  listQueues.mockResolvedValue([
    queue(1, ['202', '250'], ['201']),
    queue(2, ['209', '260']),
  ]);
  queueAgentStatus.mockImplementation(async (id: number) =>
    id === 1
      ? [
          {
            number: '201',
            name: 'x',
            loggedIn: true,
            paused: false,
            callStatus: 2,
            pauseReason: '',
            agentType: 'static',
          },
          {
            number: '202',
            name: 'x',
            loggedIn: true,
            paused: true,
            callStatus: 5,
            pauseReason: '',
            agentType: 'dynamic',
          },
          {
            number: '250',
            name: 'x',
            loggedIn: false,
            paused: false,
            callStatus: 9,
            pauseReason: '',
            agentType: 'dynamic',
          },
        ]
      : []
  );
  mocks.pbxApiFor.mockResolvedValue({
    api: { listRingGroups, listQueues, queueAgentStatus },
  });
  as('agent');
});

describe('GET /api/pbx/groups', () => {
  it('needs an agent', async () => {
    as('viewer');
    expect((await GET()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(listQueues).not.toHaveBeenCalled();
  });

  it('refuses an agent with no extension', async () => {
    as('agent', false);
    const res = await GET();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_extension');
    expect(mocks.pbxApiFor).not.toHaveBeenCalled();
  });

  it('shows only groups and queues with a member of this workspace', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    expect(await res.json()).toEqual({
      myExtension: '201',
      canManage: false,
      ringGroups: [
        {
          id: 1,
          number: '6300',
          name: 'Sales',
          strategy: 'ring_all',
          members: [
            { extension: '201', userId: 'user-1', name: 'Amal' },
            { extension: '250', userId: null, name: null },
          ],
        },
      ],
      queues: [
        {
          id: 1,
          number: '6401',
          name: 'Queue 1',
          agents: [
            {
              extension: '202',
              userId: 'user-2',
              name: 'Badr',
              static: false,
              loggedIn: true,
              paused: true,
              callStatus: 'on_hold',
            },
            {
              extension: '250',
              userId: null,
              name: null,
              static: false,
              loggedIn: false,
              paused: false,
              callStatus: 'unknown',
            },
            {
              extension: '201',
              userId: 'user-1',
              name: 'Amal',
              static: true,
              loggedIn: true,
              paused: false,
              callStatus: 'in_call',
            },
          ],
        },
      ],
      queuesTruncated: false,
    });
    expect(queueAgentStatus).toHaveBeenCalledTimes(1);
  });

  it('gives a team leader with no extension the workspace’s PBX', async () => {
    as('team_leader', false);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    const body = await res.json();
    expect(body.myExtension).toBeNull();
    expect(body.canManage).toBe(true);
    expect(body.queues.map((q: { id: number }) => q.id)).toEqual([1]);
  });

  it('answers 503 for a team leader whose workspace has no PBX', async () => {
    as('team_leader', false);
    service.tables.pbx_connections = [];
    expect((await GET()).status).toBe(503);
  });

  it('reads at most 30 queues, the caller’s own first, 5 at a time', async () => {
    const many = Array.from({ length: 34 }, (_, i) => queue(i + 1, ['202']));
    many.push(queue(99, ['201']));
    listQueues.mockResolvedValue(many);
    let running = 0;
    let peak = 0;
    queueAgentStatus.mockImplementation(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return [];
    });
    const body = await (await GET()).json();
    expect(body.queues).toHaveLength(30);
    expect(body.queues[0].id).toBe(99);
    expect(body.queuesTruncated).toBe(true);
    expect(queueAgentStatus).toHaveBeenCalledTimes(30);
    expect(peak).toBe(5);
  });

  it('maps the phone system’s failures', async () => {
    listQueues.mockRejectedValue(
      new YeastarError({
        endpoint: 'queue/list',
        errcode: 10002,
        errmsg: 'FAILURE',
      })
    );
    expect((await GET()).status).toBe(502);
  });
});
