import { beforeEach, describe, expect, it, vi } from 'vitest';

// Posting goes through meeting_post_message under the caller's client
// (no service role); its refusals map to 404 / 409 / 400 / 429. Reading
// is RLS, newest `limit` first, answered ascending.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  meeting: null as unknown,
  removal: null as unknown,
  rows: [] as unknown[],
  calls: [] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { GET, POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };
const row = (id: string, at: string) => ({
  id,
  meeting_id: M,
  account_id: 'acct-1',
  user_id: 'user-1',
  kind: 'chat',
  body: `line ${id}`,
  created_at: at,
});

function from(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'lt', 'order', 'limit']) {
    q[m] = (...a: unknown[]) => (
      table === 'meeting_messages' && mocks.calls.push(`${m} ${a.join(',')}`),
      q
    );
  }
  q.maybeSingle = async () => ({
    data: table === 'meeting_removed_users' ? mocks.removal : mocks.meeting,
    error: null,
  });
  q.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: mocks.rows, error: null }).then(ok);
  return q;
}

const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );
const get = (qs = '') => GET(new Request(`http://x/api?${qs}`), params);

describe('/api/meetings/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.calls = [];
    mocks.removal = null;
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.rpc.mockResolvedValue({
      data: row('m1', '2026-10-15T08:00:00Z'),
      error: null,
    });
  });

  it('posts through meeting_post_message and answers 201 with the row', async () => {
    const res = await post({ kind: 'chat', body: '  hello ' });
    expect(res.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith('meeting_post_message', {
      p_meeting: M,
      p_kind: 'chat',
      p_body: 'hello',
    });
    expect(await res.json()).toEqual({
      message: {
        id: 'm1',
        user_id: 'user-1',
        kind: 'chat',
        body: 'line m1',
        created_at: '2026-10-15T08:00:00Z',
      },
    });
  });

  it('maps the function’s refusals', async () => {
    const cases: [unknown, number, string?][] = [
      [{ code: '42501', message: 'not visible' }, 404],
      [{ code: 'P0001', message: 'meeting_closed' }, 409],
      [{ code: 'P0001', message: 'removed' }, 403, 'removed_from_meeting'],
      [{ code: '22023', message: 'bad body' }, 400],
      [{ code: 'P0001', message: 'rate_limited' }, 429, 'rate_limited'],
      [{ code: 'XX000', message: 'boom' }, 500],
    ];
    for (const [error, status, text] of cases) {
      mocks.rpc.mockResolvedValueOnce({ data: null, error });
      const res = await post({ kind: 'reaction', body: '👍' });
      expect(res.status).toBe(status);
      if (text) expect(await res.json()).toEqual({ error: text });
    }
  });

  it('tells a removed person why: 112 hides the meeting from them', async () => {
    mocks.removal = { user_id: 'user-1' };
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'meeting_not_visible' },
    });
    const res = await post({ kind: 'chat', body: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'removed_from_meeting' });
  });

  it('refuses a bad body before calling the database', async () => {
    expect((await post({ kind: 'reaction', body: 'x' })).status).toBe(400);
    expect((await post({ kind: 'chat', body: ' ' })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('reads the latest page before the cursor, answered ascending', async () => {
    mocks.rows = [
      row('m2', '2026-10-15T08:01:00Z'),
      row('m1', '2026-10-15T08:00:00Z'),
    ];
    const res = await get('before=2026-10-15T12:00:00%2B04:00&limit=2');
    expect(res.status).toBe(200);
    expect(
      (await res.json()).messages.map((m: { id: string }) => m.id)
    ).toEqual(['m1', 'm2']);
    expect(mocks.calls).toEqual(
      expect.arrayContaining([
        `eq meeting_id,${M}`,
        'eq kind,chat',
        'lt created_at,2026-10-15T08:00:00.000Z',
        'limit 2',
      ])
    );
  });

  it('answers 404 for a meeting the caller cannot see, 400 for a bad query', async () => {
    mocks.meeting = null;
    expect((await get()).status).toBe(404);
    expect((await get('limit=500')).status).toBe(400);
  });
});
