import { beforeEach, describe, expect, it, vi } from 'vitest';

// Starting needs meeting_can_manage; stopping also suits the person
// recording. One recording at a time, held by a compare-and-set.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  filters: [] as string[],
  /** Whose flag a stop was confined to. */
  owners: [] as string[],
  meeting: null as unknown,
  /** Successive reads, when a test needs the row to change between them. */
  reads: [] as unknown[],
  written: { data: { id: 'm' } as unknown, error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.update = (v: unknown) => (mocks.update(v), q);
      q.eq = (c: string, v: string) => {
        if (c === 'recording_by') mocks.owners.push(v);
        return q;
      };
      q.is = (c: string) => (mocks.filters.push(c), q);
      q.select = () => q;
      q.maybeSingle = async () => mocks.written;
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };
const ON = '2026-11-05T10:00:00.000Z';
const OPEN = { id: M, account_id: 'acct-1', status: 'scheduled' };

function from() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({
    data: mocks.reads.length ? mocks.reads.shift() : mocks.meeting,
    error: null,
  });
  return q;
}

const record = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );

describe('POST /api/meetings/[id]/recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.filters = [];
    mocks.owners = [];
    mocks.reads = [];
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'host-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.meeting = OPEN;
    mocks.written = { data: { id: M }, error: null };
  });

  it('starts, only if nothing is recording yet', async () => {
    const res = await record({ recording: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      recording_started_at: expect.any(String),
      recording_by: 'host-1',
    });
    expect(mocks.update).toHaveBeenCalledWith({
      recording_started_at: body.recording_started_at,
      recording_by: 'host-1',
    });
    expect(mocks.filters).toEqual(['recording_started_at']);
  });

  it('refuses a start over someone else’s recording', async () => {
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'admin-2',
    };
    const res = await record({ recording: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_recording' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers already_recording when another start wins the race', async () => {
    mocks.written = { data: null, error: null };
    const res = await record({ recording: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_recording' });
  });

  it('leaves your own running recording as it is', async () => {
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'host-1',
    };
    expect(await (await record({ recording: true })).json()).toEqual({
      ok: true,
      recording_started_at: ON,
      recording_by: 'host-1',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('lets a manager force someone else’s flag clear', async () => {
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'admin-2',
    };
    const res = await record({ recording: false, force: true });
    expect(await res.json()).toEqual({
      ok: true,
      recording_started_at: null,
      recording_by: null,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      recording_started_at: null,
      recording_by: null,
    });
    expect(mocks.filters).toEqual([]);
    expect(mocks.owners).toEqual([]);
  });

  it('a stop clears only the caller’s own recording', async () => {
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'host-1',
    };
    expect((await record({ recording: false })).status).toBe(200);
    expect(mocks.owners).toEqual(['host-1']);
  });

  it('a late stop leaves a newer recording standing, and says so', async () => {
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'admin-2',
    };
    mocks.written = { data: null, error: null };
    const res = await record({ recording: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      recording_started_at: ON,
      recording_by: 'admin-2',
    });
    expect(mocks.owners).toEqual(['host-1']);
  });

  it('a stop with nothing to clear is ok', async () => {
    mocks.written = { data: null, error: null };
    const res = await record({ recording: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      recording_started_at: null,
      recording_by: null,
    });
  });

  it('ignores force from someone who cannot manage', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'host-1',
    };
    await record({ recording: false, force: true });
    expect(mocks.owners).toEqual(['host-1']);
  });

  it('lets the person recording stop after losing manage rights', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'host-1',
    };
    expect((await record({ recording: false })).status).toBe(200);
  });

  it('answers 403 to a non-manager starting or stopping another’s', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await record({ recording: true })).status).toBe(403);
    mocks.meeting = {
      ...OPEN,
      recording_started_at: ON,
      recording_by: 'admin-2',
    };
    expect((await record({ recording: false })).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses a body without a boolean', async () => {
    expect((await record({ recording: 1 })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 404 for a meeting the caller cannot see', async () => {
    mocks.meeting = null;
    expect((await record({ recording: true })).status).toBe(404);
  });

  it('answers 409 on a closed meeting, either way', async () => {
    mocks.meeting = { ...OPEN, status: 'cancelled' };
    expect((await record({ recording: true })).status).toBe(409);
    expect((await record({ recording: false })).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 409 when a stop finds the meeting closed by then', async () => {
    mocks.written = { data: null, error: null };
    mocks.reads = [OPEN, { ...OPEN, status: 'ended' }];
    const res = await record({ recording: false });
    expect(res.status).toBe(409);
    expect((await res.json()).error).not.toBe('already_recording');
  });

  it('answers 503, not 403, when the manage check fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await record({ recording: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it.each(['42703', 'PGRST204'])(
    'answers 503 migration_required on %s, starting or stopping',
    async (code) => {
      mocks.written = { data: null, error: { code } };
      for (const recording of [true, false]) {
        const res = await record({ recording });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'migration_required' });
      }
    }
  );
});
