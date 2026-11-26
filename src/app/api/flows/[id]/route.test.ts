import { beforeEach, describe, expect, it, vi } from 'vitest';

// Saving a flow: one call, never over somebody else's save, and never
// something a live flow could not be activated with.

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  writes: [] as string[],
  flow: {} as Record<string, unknown>,
  nodes: [] as unknown[],
}));

function client(writer: string) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
    },
    rpc: (...args: unknown[]) => {
      h.writes.push(`${writer} rpc`);
      return h.rpc(...args);
    },
    from: (table: string) => {
      const write = (op: string) => () => {
        h.writes.push(`${writer} ${op} ${table}`);
        return b;
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        update: write('update'),
        insert: write('insert'),
        delete: write('delete'),
        maybeSingle: async () => ({
          data: table === 'profiles' ? { full_name: 'Sara' } : h.flow,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.nodes, error: null }).then(ok),
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => client('caller'),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireRole: async () => ({
    accountId: 'acct-1',
    userId: 'u1',
    supabase: client('caller'),
  }),
  assertSalesAccess: (ctx: unknown) => ctx,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => client('admin'),
}));

import { PUT } from './route';

const save = (body: unknown) =>
  PUT(new Request('http://x/', { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'f1' }),
  });
const good = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'bye' } },
  { node_key: 'bye', node_type: 'handoff', config: { note: '' } },
];
/** The step after `start` is gone. */
const broken = good.slice(0, 1);

beforeEach(() => {
  vi.clearAllMocks();
  h.writes = [];
  h.nodes = good;
  h.flow = {
    id: 'f1',
    status: 'active',
    name: 'Menu',
    trigger_type: 'manual',
    trigger_config: {},
    entry_node_id: 'start',
    created_at: 'T0',
    edited_at: 'T2',
    edited_by: 'u2',
  };
  h.rpc.mockResolvedValue({
    data: { edited_at: 'T3', updated_at: 'T3' },
    error: null,
  });
});

describe('PUT /api/flows/[id]', () => {
  it('saves in one call, as the caller, with the expected version', async () => {
    const res = await save({ name: ' Menu ', nodes: good, expected: 'T2' });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe('T3');
    expect(h.rpc).toHaveBeenCalledWith('flow_save', {
      p_flow: 'f1',
      p_patch: { name: 'Menu' },
      p_nodes: good,
      p_expected: 'T2',
    });
    expect(h.writes).toEqual(['caller rpc']);
  });

  it('a live flow that would not validate is not saved', async () => {
    const res = await save({ nodes: broken });
    expect(res.status).toBe(422);
    const { issues } = await res.json();
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'error', node_key: 'start' })
    );
    expect(h.writes).toEqual([]);
  });

  it('a header-only save of a live flow is checked with the stored nodes', async () => {
    expect((await save({ name: 'x' })).status).toBe(200);
    expect(h.rpc.mock.calls[0][1].p_nodes).toBeNull();
    h.nodes = broken;
    expect((await save({ name: 'x' })).status).toBe(422);
  });

  it('a draft may be incomplete', async () => {
    h.flow.status = 'draft';
    expect((await save({ nodes: broken })).status).toBe(200);
  });

  it('says who saved it, and when, instead of saving over them', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'FLOW_CHANGED' },
    });
    const res = await save({ nodes: good, expected: 'T1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Somebody else saved this flow at T2; reload to see it',
      changed: { version: 'T2', at: 'T2', by: 'Sara' },
    });
    expect(h.writes).toEqual(['caller rpc']);
  });

  it('only a database without flow_save gets the separate writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [error, status] of [
      [{ code: 'P0002', hint: 'FLOW_NOT_FOUND' }, 404],
      [{ code: '23505', hint: 'FLOW_DUPLICATE_KEY', details: 'a' }, 400],
      [{ code: '57014', message: 'timeout' }, 500],
    ] as const) {
      h.writes = [];
      h.rpc.mockResolvedValue({ data: null, error });
      expect((await save({ nodes: good })).status).toBe(status);
      expect(h.writes).toEqual(['caller rpc']);
    }
    h.writes = [];
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    const res = await save({ nodes: good });
    expect((await res.json()).version).toBeNull();
    expect(h.writes).toEqual([
      'caller rpc',
      'admin update flows',
      'admin delete flow_nodes',
      'admin insert flow_nodes',
    ]);
  });

  it('refuses nodes that are not a list', async () => {
    expect((await save({ nodes: {} })).status).toBe(400);
  });
});
