import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  setSwitches: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => ({ switches: { set: mocks.setSwitches } }),
}));

import { GET, PUT } from './route';

const SAVED_AT = '2026-10-09T08:00:00.000000+00:00';

const row = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'monitor',
  triage: true,
  guardrail: true,
  passages: false,
  watch_human_threads: true,
  languages: 'english',
  updated_at: SAVED_AT,
  updated_by: null,
  ...extra,
});

/**
 * A PostgREST stand-in: every chain method returns the builder, and the
 * result is `settings` for ts_account_settings and no rows elsewhere.
 * Records each update/insert payload and select column list.
 */
function fakeDb(settings: Record<string, unknown> | null) {
  const writes: Record<string, unknown>[] = [];
  const selects: string[] = [];
  let saved: Record<string, unknown> | null = settings;
  const from = (table: string) => {
    const result = () =>
      table === 'ts_account_settings'
        ? { data: saved, error: null }
        : { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['eq', 'order', 'limit']) b[m] = () => b;
    b.select = (cols: string) => {
      if (table === 'ts_account_settings') selects.push(cols);
      return b;
    };
    b.update = b.insert = (values: Record<string, unknown>) => {
      writes.push(values);
      saved = { ...(saved ?? row()), ...values, updated_at: 'next' };
      return b;
    };
    b.maybeSingle = async () => result();
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(result()).then(ok);
    return b;
  };
  return { db: { from }, writes, selects };
}

const switches = {
  enabled: true,
  mode: 'monitor',
  triage: true,
  guardrail: true,
  passages: false,
  watchHumanThreads: true,
  languages: 'english',
  expectedUpdatedAt: SAVED_AT,
};

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/typesafe/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

let db: ReturnType<typeof fakeDb>;
function useDb(settings: Record<string, unknown> | null) {
  db = fakeDb(settings);
  mocks.requireRole.mockResolvedValue({
    supabase: db.db,
    accountId: 'account-1',
    userId: 'user-1',
    role: 'admin',
  });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.setSwitches.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  useDb(row());
});

describe('GET /api/typesafe/settings', () => {
  it('returns the stored partner banks and the catalogue', async () => {
    useDb(row({ partner_banks: { codes: ['FAB', 'MASHREQ'], custom: [] } }));
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.partner_banks).toEqual({
      codes: ['FAB', 'MASHREQ'],
      custom: [],
    });
    expect(json.bank_catalogue).toContainEqual({
      code: 'FAB',
      name: 'First Abu Dhabi Bank (FAB)',
      defaultPartner: false,
    });
    expect(json.bank_catalogue).toContainEqual({
      code: 'MASHREQ',
      name: 'Mashreq',
      defaultPartner: true,
    });
    expect(json.settings.enabled).toBe(true);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('reads every column, so a database without 078 still loads', async () => {
    useDb(row());
    const json = await (await GET()).json();
    expect(db.selects).toEqual(['*']);
    expect(json.partner_banks).toBeNull();
  });

  it('answers the auth error to a non-admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('agent'));
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/typesafe/settings partner_banks', () => {
  it.each([
    ['not an object', 'FAB'],
    ['no codes array', { custom: [] }],
    ['a non-array custom', { codes: [], custom: {} }],
    ['a non-string code', { codes: [7] }],
    ['a custom bank without a name', { codes: [], custom: [{ aliases: [] }] }],
    [
      'non-string aliases',
      { codes: [], custom: [{ name: 'X', aliases: [1] }] },
    ],
  ])('is 400 on %s, before any write', async (_label, partner_banks) => {
    const res = await put({ ...switches, partner_banks });
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it('is 400 on an unknown bank code', async () => {
    const res = await put({ ...switches, partner_banks: { codes: ['NOPE'] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown bank code "NOPE"/);
    expect(db.writes).toHaveLength(0);
  });

  it('is 400 over the size limits', async () => {
    const res = await put({
      ...switches,
      partner_banks: {
        codes: [],
        custom: [{ name: 'X', aliases: Array(11).fill('a') }],
      },
    });
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it('writes a normalised list in the version-checked update', async () => {
    const res = await put({
      ...switches,
      partner_banks: {
        codes: [' fab ', 'MASHREQ'],
        custom: [{ name: ' Some Bank ', aliases: ['SB', 'sb'] }],
      },
    });
    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.partner_banks).toEqual({
      codes: ['FAB', 'MASHREQ'],
      custom: [{ name: 'Some Bank', aliases: ['SB'] }],
    });
    expect((await res.json()).partner_banks.codes).toEqual(['FAB', 'MASHREQ']);
    expect(mocks.setSwitches).toHaveBeenCalledOnce();
  });

  it('null resets to the built-in list', async () => {
    useDb(row({ partner_banks: { codes: ['FAB'], custom: [] } }));
    const res = await put({ ...switches, partner_banks: null });
    expect(res.status).toBe(200);
    expect(db.writes[0]).toHaveProperty('partner_banks', null);
    expect((await res.json()).partner_banks).toBeNull();
  });

  it('leaves the list alone when the body has none', async () => {
    const res = await put(switches);
    expect(res.status).toBe(200);
    expect(db.writes[0]).not.toHaveProperty('partner_banks');
  });

  it('is 409 when someone saved since, writing nothing', async () => {
    const res = await put({
      ...switches,
      expectedUpdatedAt: '2026-10-01T00:00:00Z',
      partner_banks: { codes: ['FAB'] },
    });
    expect(res.status).toBe(409);
    expect(db.writes).toHaveLength(0);
    const json = await res.json();
    expect(json.reason).toBe('changed');
    expect(json.current.bank_catalogue.length).toBeGreaterThan(0);
  });
});
