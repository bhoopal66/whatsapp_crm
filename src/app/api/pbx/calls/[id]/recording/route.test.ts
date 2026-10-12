import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
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

import { POST } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const CALL = '00000000-0000-4000-8000-000000000001';
const HIDDEN = '00000000-0000-4000-8000-000000000002';
const PATH = `account-${A}/calls/${CALL}.wav`;
const call = (id: string) => ({
  id,
  account_id: A,
  recording_state: 'fetched',
  started_at: '2026-10-12T08:00:00.000Z',
  contact_id: null,
  remote_number: '971501234567',
});
let rls: FakeDb;
let service: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: A, userId: 'user-1', role, supabase: rls.db };
  });
}
/** As call_access_log_guard: pbx_recording_playable() or SQLSTATE 55000. */
const refuseLog = () =>
  service.fail('call_access_log', 'insert', {
    code: '55000',
    message: 'This recording is not playable (held, erased or not fetched)',
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The caller's RLS shows CALL only; the service role sees both.
  rls = createFakeDb({ calls: [call(CALL)] });
  service = createFakeDb({
    calls: [call(CALL), call(HIDDEN)],
    call_recordings: [
      { call_id: CALL, account_id: A, storage_path: PATH },
      {
        call_id: HIDDEN,
        account_id: A,
        storage_path: `account-${A}/calls/${HIDDEN}.wav`,
      },
    ],
    call_access_log: [],
  });
  mocks.service = service.db;
  as('agent');
});
afterEach(() => vi.unstubAllEnvs());

const post = (body: unknown, id = CALL) =>
  POST(
    new Request(`https://crm.example.com/api/pbx/calls/${id}/recording`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
const signs = () => service.log.filter((l) => l.op === 'sign');

describe('POST /api/pbx/calls/[id]/recording', () => {
  it('needs an agent', async () => {
    as('viewer');
    expect((await post({ action: 'play' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(service.log).toEqual([]);
  });

  it('logs the play before signing a 5-minute link on the public origin', async () => {
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://kong:8000');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.com');
    const before = Date.now();
    const res = await post({ action: 'play' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toBe(
      `https://db.example.com/storage/v1/object/sign/call-recordings/${PATH}?token=t300`
    );
    const expires = Date.parse(body.expiresAt) - before;
    expect(expires).toBeGreaterThanOrEqual(300_000);
    expect(expires).toBeLessThan(301_000);

    expect(service.tables.call_access_log).toEqual([
      expect.objectContaining({
        call_id: CALL,
        account_id: A,
        user_id: 'user-1',
        action: 'play',
      }),
    ]);
    expect(signs()).toEqual([
      {
        table: 'storage:call-recordings',
        op: 'sign',
        payload: { path: PATH, expiresIn: 300, download: null },
      },
    ]);
    // Logged before signing.
    const logged = service.log.findIndex(
      (l) => l.table === 'call_access_log' && l.op === 'insert'
    );
    expect(logged).toBeGreaterThanOrEqual(0);
    expect(logged).toBeLessThan(service.log.indexOf(signs()[0]));
  });

  it('refuses a download to an agent, before logging or signing', async () => {
    const res = await post({ action: 'download' });
    expect(res.status).toBe(403);
    expect(service.tables.call_access_log).toEqual([]);
    expect(signs()).toEqual([]);
  });

  it('lets a team leader download, logged as a download', async () => {
    as('team_leader');
    const res = await post({ action: 'download' });
    expect(res.status).toBe(200);
    expect(service.tables.call_access_log[0].action).toBe('download');
    expect(signs()[0].payload).toMatchObject({ download: true });
  });

  it('holds a recording the log refuses: 409, nothing signed', async () => {
    refuseLog();
    const res = await post({ action: 'play' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Recording held until the notice is confirmed',
    });
    expect(signs()).toEqual([]);

    rls.tables.calls[0].recording_state = 'erased';
    refuseLog();
    const erased = await post({ action: 'play' });
    expect(erased.status).toBe(409);
    expect(await erased.json()).toEqual({ error: 'This recording was erased' });
    expect(signs()).toEqual([]);
  });

  it('never signs for a call the caller cannot see', async () => {
    as('admin');
    for (const action of ['play', 'download']) {
      const res = await post({ action }, HIDDEN);
      expect(res.status).toBe(404);
    }
    expect(service.log).toEqual([]);
  });

  it('validates the request', async () => {
    expect((await post({ action: 'stream' })).status).toBe(400);
    expect((await post({ action: 'play' }, 'nope')).status).toBe(404);
    expect(service.log).toEqual([]);
  });
});
