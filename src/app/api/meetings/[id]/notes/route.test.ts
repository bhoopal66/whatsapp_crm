import { beforeEach, describe, expect, it, vi } from 'vitest';

// The notes run on the caller's client (176 grants the save function to
// `authenticated` only), and the build can run ahead of 176: the panel
// hides itself on GET and a save says so instead of a 500.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  meeting: null as unknown,
  meetingError: null as unknown,
  notes: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: mocks.admin,
}));

import { GET, PUT } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };

const ROW = {
  body: 'Minutes',
  version: 3,
  updated_by: 'user-2',
  updated_at: '2026-11-05T10:00:00.000Z',
};

function from(table: string) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () =>
    table === 'meetings'
      ? { data: mocks.meeting, error: mocks.meetingError }
      : mocks.notes;
  return q;
}

const read = () => GET(new Request('http://x'), params);
const save = (body: unknown) =>
  PUT(
    new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    params
  );
const good = { body: 'New minutes', expectedVersion: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getCurrentAccount.mockResolvedValue({
    role: 'agent',
    userId: 'user-1',
    accountId: 'acct-1',
    supabase: { from, rpc: mocks.rpc },
  });
  mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
  mocks.meetingError = null;
  mocks.notes = { data: ROW, error: null };
});

describe('GET /api/meetings/[id]/notes', () => {
  it('answers the row', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: ROW, available: true });
  });

  it('answers null with available when nobody has written yet', async () => {
    mocks.notes = { data: null, error: null };
    expect(await (await read()).json()).toEqual({
      notes: null,
      available: true,
    });
  });

  it.each(['42P01', 'PGRST205'])(
    'answers 200, not available, before 176 (%s)',
    async (code) => {
      mocks.notes = { data: null, error: { code } };
      const res = await read();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notes: null, available: false });
    }
  );

  it('answers 404 for a meeting the caller cannot see, 176 or not', async () => {
    mocks.meeting = null;
    expect((await read()).status).toBe(404);
    mocks.notes = { data: null, error: { code: '42P01' } };
    expect((await read()).status).toBe(404);
  });

  it('answers 503 when the meeting read fails', async () => {
    mocks.meeting = null;
    mocks.meetingError = { code: '57014' };
    const res = await read();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('answers 503 when the notes read fails, not "unavailable"', async () => {
    mocks.notes = { data: null, error: { code: '57014' } };
    expect((await read()).status).toBe(503);
  });

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from, rpc: mocks.rpc },
    });
    expect((await read()).status).toBe(403);
  });
});

describe('PUT /api/meetings/[id]/notes', () => {
  const refuse = (code: string, message = '') =>
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message } });

  beforeEach(() => {
    mocks.rpc.mockResolvedValue({
      data: { version: 3, updated_at: 'now', updated_by: 'user-1' },
      error: null,
    });
  });

  it('saves through the caller’s client and answers the new version', async () => {
    const res = await save(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: 3,
      updated_at: 'now',
      updated_by: 'user-1',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('meeting_save_notes', {
      p_meeting: M,
      p_body: 'New minutes',
      p_expected_version: 2,
    });
    // Revoked from the service role: it would fail for everyone.
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('leaves a closed meeting to the function: a manager may still save', async () => {
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'ended' };
    expect((await save(good)).status).toBe(200);
  });

  it('refuses a bad body before calling the function', async () => {
    expect((await save({ body: 5, expectedVersion: 1 })).status).toBe(400);
    expect((await save({ body: 'x' })).status).toBe(400);
    expect(
      (await save({ body: 'a'.repeat(20_001), expectedVersion: 1 })).status
    ).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 404 to meeting_not_visible', async () => {
    refuse('42501', 'meeting_not_visible');
    expect((await save(good)).status).toBe(404);
  });

  it('answers 409 meeting_closed', async () => {
    refuse('P0001', 'meeting_closed');
    const res = await save(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'meeting_closed' });
  });

  it('answers 400 to invalid_body', async () => {
    refuse('22023', 'invalid_body');
    expect((await save(good)).status).toBe(400);
  });

  it('answers 409 stale with the current row to reconcile', async () => {
    refuse('MN001', 'STALE');
    const res = await save(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale', notes: ROW });
  });

  it('answers stale with null when no row is left', async () => {
    refuse('MN001', 'STALE');
    mocks.notes = { data: null, error: null };
    expect(await (await save(good)).json()).toEqual({
      error: 'stale',
      notes: null,
    });
  });

  it('answers 503 when the read-back after a stale save fails', async () => {
    refuse('MN001', 'STALE');
    mocks.notes = { data: null, error: { code: '57014' } };
    const res = await save(good);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it.each(['42883', 'PGRST202'])(
    'answers 503 migration_required on %s',
    async (code) => {
      refuse(code);
      const res = await save(good);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'migration_required' });
    }
  );

  it('keeps any other failure a 500', async () => {
    refuse('XX000');
    expect((await save(good)).status).toBe(500);
  });
});
