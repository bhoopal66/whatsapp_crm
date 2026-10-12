import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Reply } from '@/lib/journeys/host/fake-db';
import { JourneyConflictError } from '@/lib/journeys/runner';
import { SHIPPED_WORKFLOW } from '@/lib/journeys/workflow';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  handle: vi.fn(),
  createRunner: vi.fn(),
  admin: { tag: 'service-role' },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: { message: string; status?: number }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => h.admin,
}));
vi.mock('@/lib/journeys/runner', async (orig) => ({
  ...(await orig<typeof import('@/lib/journeys/runner')>()),
  createRunner: h.createRunner,
}));
vi.mock('@/lib/journeys/host/sink', () => ({
  createJourneySink: () => ({ deliver: vi.fn() }),
}));

import { POST } from './route';

const FILE_ID = '0b8f7a3e-6a0d-4c8e-9a51-1f2e3d4c5b6a';
const KEY = 'taamul_welcome_to_close.v1';

function setup(...replies: Reply[]) {
  const { db, queries } = fakeDb(...replies);
  h.requireRole.mockResolvedValue({
    supabase: db,
    userId: 'user-1',
    accountId: 'acc-1',
    role: 'agent',
  });
  return queries;
}

const fileRow = (state: string, outcome: unknown = null): Reply => ({
  data: { id: FILE_ID, state, workflow_key: KEY, outcome },
});

const post = (body: unknown, fileId = FILE_ID) =>
  POST(
    new Request(`http://localhost/api/journeys/${fileId}/advisor`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ fileId }) }
  );

const okResult = (state: string, outcome: unknown = null, drain = {}) => ({
  status: 'ok',
  result: {
    file: { state, outcome },
    actions: [],
    warnings: [{ code: 'W', message: 'w' }],
  },
  drain: { delivered: 1, pending: 0, ...drain },
});

describe('POST /api/journeys/[fileId]/advisor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createRunner.mockReturnValue({ handle: h.handle });
  });

  it('needs an agent', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 })
    );
    const res = await post({ decision: 'QUOTE_READY' });
    expect(res.status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('agent');
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('runs a decision the state handles on the service-role runner', async () => {
    const queries = setup(fileRow('P_QUOTE_WAIT'));
    h.handle.mockResolvedValue(okResult('P_DECIDE'));
    const res = await post({
      decision: 'QUOTE_READY',
      validUntil: '2026-10-20T12:00:00+04:00',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'P_DECIDE',
      outcome: null,
      warnings: [{ code: 'W', message: 'w' }],
    });
    expect(queries[0]).toEqual(
      expect.arrayContaining([
        ['from', 'journey_files'],
        ['eq', 'id', FILE_ID],
        ['eq', 'account_id', 'acc-1'],
      ])
    );
    expect(h.createRunner).toHaveBeenCalledWith(
      expect.objectContaining({ def: SHIPPED_WORKFLOW })
    );
    const event = h.handle.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'ADVISOR',
      decision: 'QUOTE_READY',
      validUntil: '2026-10-20T08:00:00.000Z',
      by: 'user-1',
      fileId: FILE_ID,
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it('refuses a decision the state does not handle, before the engine', async () => {
    setup(fileRow('P_QUOTE_WAIT'));
    const res = await post({ decision: 'FIT' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'DECISION_NOT_AVAILABLE' });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('offers a parked file the PARKED decisions', async () => {
    setup(fileRow('PARKED', { kind: 'PARKED', reason: 'NO_RESPONSE' }));
    h.handle.mockResolvedValue(okResult('P_DECIDE'));
    expect((await post({ decision: 'QUOTE_READY' })).status).toBe(200);
    setup(fileRow('PARKED', { kind: 'PARKED', reason: 'NO_RESPONSE' }));
    expect((await post({ decision: 'DOCS_COMPLETE' })).status).toBe(400);
  });

  it('needs a reason to close', async () => {
    for (const body of [
      { decision: 'CLOSE' },
      { decision: 'CLOSE', reasonCode: '  ' },
    ]) {
      setup(fileRow('DOCS'));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'REASON_REQUIRED' });
    }
    expect(h.handle).not.toHaveBeenCalled();

    setup(fileRow('DOCS'));
    h.handle.mockResolvedValue(
      okResult('CLOSED_ADVISOR', { kind: 'NOT_WON', reason: 'DUPLICATE' })
    );
    const res = await post({ decision: 'CLOSE', reasonCode: ' DUPLICATE ' });
    expect(res.status).toBe(200);
    expect(h.handle.mock.calls[0][0]).toMatchObject({
      reasonCode: 'DUPLICATE',
    });
  });

  it('validates the body', async () => {
    for (const body of [
      null,
      {},
      { decision: 7 },
      { decision: 'QUOTE_READY', validUntil: 'next week' },
      { decision: 'CLOSE', reasonCode: 42 },
    ]) {
      setup(fileRow('P_QUOTE_WAIT'));
      expect((await post(body)).status).toBe(400);
    }
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('answers 404 for a file the caller cannot see or a malformed id', async () => {
    setup({ data: null });
    expect((await post({ decision: 'QUOTE_READY' })).status).toBe(404);
    setup();
    expect((await post({ decision: 'QUOTE_READY' }, 'nope')).status).toBe(404);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it("maps the engine's rejection to 400 with its code", async () => {
    setup(fileRow('SUBMITTED'));
    h.handle.mockResolvedValue({
      status: 'rejected',
      error: { code: 'WRONG_PRODUCT', message: 'POS only' },
    });
    const res = await post({ decision: 'PARTNER_APPROVED' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'POS only',
      code: 'WRONG_PRODUCT',
    });
  });

  it('answers 409 when the file keeps changing, and flags a failed delivery', async () => {
    setup(fileRow('DOCS'));
    h.handle.mockRejectedValue(new JourneyConflictError(FILE_ID, 'e', 4));
    const res = await post({ decision: 'DOCS_COMPLETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CONFLICT' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup(fileRow('DOCS'));
    h.handle.mockResolvedValue(
      okResult('SUBMITTED', null, { pending: 1, error: new Error('gateway') })
    );
    const res2 = await post({ decision: 'DOCS_COMPLETE' });
    expect(res2.status).toBe(200);
    expect((await res2.json()).error).toMatch(/retried/);
    log.mockRestore();
  });
});
