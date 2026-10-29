import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from '@/lib/cases/read-fakes';

const m = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  admin: null as unknown,
  suggestions: {} as Record<string, unknown>,
  available: true,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof real.requireRole>[0]) => {
      if (!hasMinRole(m.ctx.role as typeof min, min))
        throw new real.ForbiddenError('Insufficient role');
      return m.ctx;
    },
  };
});
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/cases/status-map', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cases/status-map')>();
  return {
    ...real,
    suggestStages: vi.fn(async () => m.suggestions),
    suggestionsAvailable: () => m.available,
  };
});

import { suggestStages } from '@/lib/cases/status-map';

import { DELETE, GET, PUT } from './route';

const overviewRow = {
  stages: ['Submitted', 'Under review'],
  mapped: [
    {
      status_key: 'BANK OK',
      status_label: 'Bank OK',
      stage: 'Under review',
      source: 'admin',
      suggested_p: null,
      open_cases: 3,
      unresolved_open_cases: 0,
    },
  ],
  unmapped: [
    { status_key: 'WITH CREDIT', sample_label: 'With credit', open_cases: 2 },
  ],
};

let admin: FakeClient;
let result: Record<string, { data?: unknown; error?: unknown }>;
const as = (role: string) => {
  m.ctx = { userId: 'u-1', accountId: 'acct-1', role, supabase: null };
};
const get = (q = '') => GET(new Request(`http://x/api/cases/status-map${q}`));
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));
const del = (q: string) =>
  DELETE(
    new Request(`http://x/api/cases/status-map${q}`, { method: 'DELETE' })
  );

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  result = {
    case_status_map_overview: { data: overviewRow },
    case_status_map_set: {
      data: {
        status_key: 'WITH CREDIT',
        status_label: 'With credit',
        stage: 'Under review',
        source: 'suggestion',
        suggested_p: 0.8,
      },
    },
    case_status_map_delete: { data: true },
  };
  admin = new FakeClient('admin', [], {
    case_status_map_overview: () => result.case_status_map_overview as never,
    case_status_map_set: () => result.case_status_map_set as never,
    case_status_map_delete: () => result.case_status_map_delete as never,
  });
  m.admin = admin.client;
  m.suggestions = {
    'WITH CREDIT': { stage: 'Under review', p: 0.8, runnerUp: null },
  };
  m.available = true;
  as('admin');
});

describe('GET status map', () => {
  it('answers the overview, suggestions and availability', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...overviewRow,
      suggestions: m.suggestions,
      available: true,
    });
    expect(admin.rpcs).toEqual([
      { fn: 'case_status_map_overview', args: { p_actor: 'u-1' } },
    ]);
    expect(vi.mocked(suggestStages)).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ stages: overviewRow.stages })
    );
  });

  it('skips Jev with ?suggestions=0 but still answers availability', async () => {
    vi.mocked(suggestStages).mockClear();
    m.available = false;
    const res = await get('?suggestions=0');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...overviewRow,
      suggestions: {},
      available: false,
    });
    expect(vi.mocked(suggestStages)).not.toHaveBeenCalled();
  });

  it('answers 403 to a team leader', async () => {
    as('team_leader');
    expect((await get()).status).toBe(403);
    expect(admin.rpcs).toEqual([]);
  });

  it('maps a NOT_ALLOWED refusal to 403', async () => {
    result.case_status_map_overview = {
      error: { hint: 'NOT_ALLOWED', code: '42501' },
    };
    expect((await get()).status).toBe(403);
  });
});

describe('PUT status map', () => {
  it('sets a mapping for the caller', async () => {
    const res = await put({
      status: 'With credit',
      stage: 'Under review',
      source: 'suggestion',
      suggestedP: 0.8,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mapping: {
        status_key: 'WITH CREDIT',
        status_label: 'With credit',
        stage: 'Under review',
        source: 'suggestion',
        suggested_p: 0.8,
      },
    });
    expect(admin.rpcs[0]).toEqual({
      fn: 'case_status_map_set',
      args: {
        p_actor: 'u-1',
        p_status: 'With credit',
        p_stage: 'Under review',
        p_source: 'suggestion',
        p_suggested_p: 0.8,
      },
    });
  });

  it('validates the body before any call', async () => {
    const ok = { status: 'S', stage: 'Submitted', source: 'admin' };
    expect((await put({ ...ok, status: '' })).status).toBe(400);
    expect((await put({ ...ok, status: 'x'.repeat(65) })).status).toBe(400);
    expect((await put({ ...ok, stage: 'x'.repeat(101) })).status).toBe(400);
    expect((await put({ ...ok, source: 'jev' })).status).toBe(400);
    expect((await put({ ...ok, suggestedP: 1.5 })).status).toBe(400);
    expect((await put({ ...ok, suggestedP: '0.5' })).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
    expect((await put(ok)).status).toBe(200);
    expect(admin.rpcs[0]!.args.p_suggested_p).toBeNull();
  });

  it('answers a HINT refusal with 422 and its code', async () => {
    result.case_status_map_set = {
      error: { hint: 'STAGE_NOT_ALLOWED', code: '23514' },
    };
    const res = await put({ status: 'S', stage: 'Approved', source: 'admin' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'A status cannot map to a pre-submission or final stage',
      code: 'STAGE_NOT_ALLOWED',
    });
  });

  it('answers 403 to an agent', async () => {
    as('agent');
    expect(
      (await put({ status: 'S', stage: 'Submitted', source: 'admin' })).status
    ).toBe(403);
  });
});

describe('DELETE status map', () => {
  it('deletes the mapping named by ?status=', async () => {
    const res = await del('?status=Bank%20OK');
    expect(await res.json()).toEqual({ deleted: true });
    expect(admin.rpcs[0]).toEqual({
      fn: 'case_status_map_delete',
      args: { p_actor: 'u-1', p_status: 'Bank OK' },
    });
  });

  it('needs a status', async () => {
    expect((await del('')).status).toBe(400);
    expect(admin.rpcs).toEqual([]);
  });

  it('answers a HINT refusal with 422 and its code', async () => {
    result.case_status_map_delete = {
      error: { hint: 'STATUS_INVALID', code: '23514' },
    };
    const res = await del('?status=x');
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('STATUS_INVALID');
  });

  it('answers 403 to a viewer', async () => {
    as('viewer');
    expect((await del('?status=x')).status).toBe(403);
  });
});
