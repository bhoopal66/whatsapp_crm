import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => Response.json({ error: 'slow' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 1 } },
}));

import { GET, POST } from './route';
import { GET as LEFT } from '../../left-work/route';

const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';
const COUNTS = { chats: 3, tasks: 2, deals: 1, contacts: 0 };

const at = (userId: string) => ({ params: Promise.resolve({ userId }) });
const get = (userId = FROM) =>
  GET(new Request('http://localhost/x'), at(userId));
const post = (body: unknown, userId = FROM) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    at(userId)
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    accountId: 'a',
    userId: 'admin-1',
    role: 'admin',
  });
});

describe('members/[userId]/handover', () => {
  it('needs an admin, on every method', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    for (const res of [await get(), await post({}), await LEFT()]) {
      expect(res.status).toBe(403);
    }
    expect(mocks.requireRole.mock.calls).toEqual([
      ['admin'],
      ['admin'],
      ['admin'],
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns the counts', async () => {
    mocks.rpc.mockResolvedValue({ data: COUNTS, error: null });
    const res = await get();
    expect(await res.json()).toEqual({ counts: COUNTS });
    expect(mocks.rpc).toHaveBeenCalledWith('member_work_counts', {
      p_user: FROM,
    });
    expect((await get('x')).status).toBe(400);
  });

  it('hands over and returns what moved', async () => {
    mocks.rpc.mockResolvedValue({ data: COUNTS, error: null });
    const res = await post({ to: TO, what: ['tasks', 'chats', 'tasks'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: COUNTS });
    expect(mocks.rpc).toHaveBeenCalledWith('member_handover', {
      p_from: FROM,
      p_to: TO,
      p_what: ['chats', 'tasks'],
    });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      'admin:memberHandover:admin-1',
      { limit: 1 }
    );
  });

  it('refuses a bad id, body or kind without calling the RPC', async () => {
    const what = ['chats'];
    expect((await post({ to: TO, what }, 'x')).status).toBe(400);
    for (const body of [
      'not json',
      {},
      { to: 'x', what },
      { to: 5, what },
      { to: TO },
      { to: TO, what: [] },
      { to: TO, what: 'chats' },
      { to: TO, what: ['chats', 'cases'] },
      { to: TO, what: [null] },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('is rate limited', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false });
    expect((await post({ to: TO, what: ['chats'] })).status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC errors', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [code, status] of [
      ['42501', 403],
      ['22023', 400],
      ['XX000', 500],
    ] as const) {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: 'why' },
      });
      for (const res of [
        await get(),
        await post({ to: TO, what: ['chats'] }),
      ]) {
        expect(res.status).toBe(status);
        const { error } = await res.json();
        if (status === 500) expect(error).not.toMatch(/why/);
        else expect(error).toBe('why');
      }
    }
    quiet.mockRestore();
  });
});

describe('members/left-work', () => {
  it('lists the deactivated members who still hold something', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ user_id: FROM, ...COUNTS }, { user_id: null }, null],
      error: null,
    });
    const res = await LEFT();
    expect(await res.json()).toEqual({
      members: [{ userId: FROM, ...COUNTS }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('members_left_work');
  });

  it('maps the RPC errors', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'why' },
    });
    expect((await LEFT()).status).toBe(403);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'why' },
    });
    expect((await LEFT()).status).toBe(500);
    quiet.mockRestore();
  });
});
