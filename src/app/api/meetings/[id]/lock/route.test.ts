import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking needs meeting_can_manage through the caller's client; only then
// does the service role write, and a database without 176 says so.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  meeting: null as unknown,
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
      q.eq = () => q;
      q.select = () => q;
      q.maybeSingle = async () => mocks.written;
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };

function from() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({ data: mocks.meeting, error: null });
  return q;
}

const lock = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );

describe('POST /api/meetings/[id]/lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'host-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.written = { data: { id: M }, error: null };
  });

  it('locks, stamping who and when', async () => {
    const res = await lock({ locked: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, locked_at: expect.any(String) });
    expect(mocks.rpc).toHaveBeenCalledWith('meeting_can_manage', {
      p_meeting: M,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      locked_at: body.locked_at,
      locked_by: 'host-1',
    });
  });

  it('unlocks, clearing both', async () => {
    const res = await lock({ locked: false });
    expect(await res.json()).toEqual({ ok: true, locked_at: null });
    expect(mocks.update).toHaveBeenCalledWith({
      locked_at: null,
      locked_by: null,
    });
  });

  it('refuses a body without a boolean', async () => {
    expect((await lock({ locked: 'yes' })).status).toBe(400);
    expect((await lock(null)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-manager, writing nothing', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await lock({ locked: true })).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a meeting the caller cannot see', async () => {
    mocks.meeting = null;
    expect((await lock({ locked: true })).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 409 on a closed meeting', async () => {
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'ended' };
    expect((await lock({ locked: true })).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 409 when the meeting closed before the write', async () => {
    mocks.written = { data: null, error: null };
    expect((await lock({ locked: true })).status).toBe(409);
  });

  it('answers 503, not 403, when the manage check fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await lock({ locked: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['42703', 'PGRST204'])(
    'answers 503 migration_required on %s',
    async (code) => {
      mocks.written = { data: null, error: { code } };
      const res = await lock({ locked: true });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'migration_required' });
    }
  );

  it('keeps any other write failure a 500', async () => {
    mocks.written = { data: null, error: { code: 'XX000' } };
    expect((await lock({ locked: true })).status).toBe(500);
  });
});
