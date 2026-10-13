import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { PUT } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const CALL = '00000000-0000-4000-8000-0000000000c1';
let rls: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: A, userId: 'me', role, supabase: rls.db };
  });
}
const put = (body: unknown, id = CALL) =>
  PUT(
    new Request(`http://x/api/pbx/calls/${id}/legal-hold`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
const rpcCalls = () => rls.log.filter((l) => l.op === 'rpc');

beforeEach(() => {
  vi.clearAllMocks();
  rls = createFakeDb(
    {
      calls: [
        { id: CALL, account_id: A, recording_state: 'fetched', started_at: '' },
      ],
    },
    {
      pbx_set_recording_hold: (args) => ({ data: args.p_hold, error: null }),
    }
  );
});

describe('PUT /api/pbx/calls/[id]/legal-hold', () => {
  it('places a hold on the caller session, with the reason', async () => {
    as('admin');
    const res = await put({ hold: true, reason: '  Court order 12  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ legalHold: true });
    expect(rpcCalls()).toEqual([
      {
        table: 'rpc:pbx_set_recording_hold',
        op: 'rpc',
        payload: { p_call_id: CALL, p_hold: true, p_reason: 'Court order 12' },
      },
    ]);
  });

  it('is an owner or admin action: a team leader is refused before any write', async () => {
    as('team_leader');
    const res = await put({ hold: true, reason: 'Court order 12' });
    expect(res.status).toBe(403);
    expect(rpcCalls()).toEqual([]);
  });

  it('wants a hold flag and a reason of 5+ characters', async () => {
    as('owner');
    expect((await put({ hold: 'yes', reason: 'Court order' })).status).toBe(
      400
    );
    expect((await put({ hold: false, reason: ' abc ' })).status).toBe(400);
    expect(rpcCalls()).toEqual([]);
  });

  it('answers 404 for a call the caller cannot see', async () => {
    as('admin');
    rls.tables.calls = [];
    const res = await put({ hold: true, reason: 'Court order 12' });
    expect(res.status).toBe(404);
    expect(rpcCalls()).toEqual([]);
  });

  it('words the function refusals: deleted audio is 409, no recording 404', async () => {
    as('admin');
    rls.rpcs.pbx_set_recording_hold = () => ({
      data: null,
      error: { code: '55000', message: 'This recording was already deleted' },
    });
    const gone = await put({ hold: true, reason: 'Court order 12' });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({
      error: 'This recording was already deleted',
    });
    rls.rpcs.pbx_set_recording_hold = () => ({
      data: null,
      error: { code: 'P0002', message: 'This call has no stored recording' },
    });
    expect((await put({ hold: true, reason: 'Court order 12' })).status).toBe(
      404
    );
  });
});
