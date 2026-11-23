import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
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

const KEY = (id: string, created_by: string | null, over = {}) => ({
  id,
  name: `key ${id}`,
  last_used_at: null,
  created_by,
  expires_at: null,
  revoked_at: null,
  ...over,
});

/** `from(table)` answers each table with its rows (or a failure). */
function tables(rows: Record<string, unknown[] | 'fail'>) {
  mocks.from.mockImplementation((table: string) => {
    const r = rows[table];
    const result =
      r === 'fail'
        ? { data: null, error: { message: 'boom' } }
        : { data: r ?? [], error: null };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => Promise.resolve(result);
    b.then = (f: (v: unknown) => unknown) => Promise.resolve(result).then(f);
    return b;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tables({});
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc, from: mocks.from },
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

  it('returns the counts and the live keys that person made', async () => {
    tables({
      api_keys: [
        KEY('mine', FROM),
        KEY('theirs', TO),
        KEY('revoked', FROM, { revoked_at: '2026-01-01T00:00:00Z' }),
        KEY('expired', FROM, { expires_at: '2020-01-01T00:00:00Z' }),
      ],
    });
    mocks.rpc.mockResolvedValue({ data: COUNTS, error: null });
    const res = await get();
    expect(await res.json()).toEqual({
      counts: COUNTS,
      keys: [
        { id: 'mine', name: 'key mine', lastUsedAt: null, createdBy: FROM },
      ],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('member_work_counts', {
      p_user: FROM,
    });
    expect((await get('x')).status).toBe(400);
  });

  it('answers keys: null when the keys cannot be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    tables({ api_keys: 'fail' });
    mocks.rpc.mockResolvedValue({ data: COUNTS, error: null });
    expect(await (await get()).json()).toEqual({ counts: COUNTS, keys: null });
    quiet.mockRestore();
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
      keys: [],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('members_left_work');
  });

  it('lists live keys whose maker is gone, lowered, deactivated or unknown', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    tables({
      api_keys: [
        KEY('ok', 'admin-1'),
        KEY('off', 'gone'),
        KEY('low', 'agent-1'),
        KEY('none', null),
        KEY('stranger', 'nobody'),
        KEY('revoked', 'gone', { revoked_at: '2026-01-01T00:00:00Z' }),
      ],
      profiles: [
        { user_id: 'admin-1', account_role: 'admin', deactivated_at: null },
        {
          user_id: 'gone',
          account_role: 'admin',
          deactivated_at: '2026-01-01',
        },
        { user_id: 'agent-1', account_role: 'agent', deactivated_at: null },
      ],
    });
    const { keys } = await (await LEFT()).json();
    expect(keys.map((k: { id: string }) => k.id)).toEqual([
      'off',
      'low',
      'none',
      'stranger',
    ]);
  });

  it('answers keys: null when the keys or the roster cannot be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    tables({ api_keys: 'fail' });
    expect((await (await LEFT()).json()).keys).toBeNull();
    tables({ api_keys: [KEY('a', 'x')], profiles: 'fail' });
    expect((await (await LEFT()).json()).keys).toBeNull();
    quiet.mockRestore();
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
