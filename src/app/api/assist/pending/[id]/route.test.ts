import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb } from '@/lib/assist/test-fakes';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/groups/server', () => ({ supabaseAdmin: () => m.admin }));

import { UnauthorizedError } from '@/lib/auth/account';
import { POST } from './route';

const ID = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NONCE = 'abcdef0123456789abcd';

let db: FakeDb;

const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/assist/pending/${id}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: USER,
  account_id: ACCOUNT,
  status: 'pending',
  action_hash: 'h',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb({ assist_pending_confirm: { data: false } });
  m.admin = db;
  m.getCurrentAccount.mockResolvedValue({
    userId: USER,
    accountId: ACCOUNT,
    role: 'agent',
  });
});

describe('POST /api/assist/pending/[id]', () => {
  it('confirms as the signed-in user from the dashboard channel', async () => {
    db.script.assist_pending_confirm = { data: true };
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'confirmed' });
    expect(db.rpcCalls('assist_pending_confirm')).toEqual([
      {
        p_id: ID,
        p_user: USER,
        p_account: ACCOUNT,
        p_nonce: NONCE,
        p_actor: `human:${USER}@dashboard`,
        p_decision: 'confirmed',
      },
    ]);
  });

  it('denies', async () => {
    db.script.assist_pending_confirm = { data: true };
    const res = await post({ decision: 'deny', nonce: NONCE });
    expect(await res.json()).toEqual({ ok: true, status: 'denied' });
    expect(db.rpcCalls('assist_pending_confirm')[0]?.p_decision).toBe('denied');
  });

  it.each([
    ['a non-uuid id', { decision: 'confirm', nonce: NONCE }, 'not-a-uuid'],
    [
      'a 19-character nonce',
      { decision: 'confirm', nonce: NONCE.slice(1) },
      ID,
    ],
    ['a 21-character nonce', { decision: 'confirm', nonce: `${NONCE}a` }, ID],
    [
      'an upper-case nonce',
      { decision: 'confirm', nonce: NONCE.toUpperCase() },
      ID,
    ],
    ['a non-string nonce', { decision: 'confirm', nonce: 12345 }, ID],
    ['an unknown decision', { decision: 'approve', nonce: NONCE }, ID],
    ['a missing body', 'not json', ID],
  ])('answers 400 for %s, touching nothing', async (_n, body, id) => {
    const res = await post(body, id);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
    expect(db.calls).toEqual([]);
  });

  it.each([
    ['NOT_PENDING', row({ status: 'consumed' })],
    ['EXPIRED', row({ status: 'expired' })],
    ['BAD_NONCE', row()],
  ])('answers 409 %s', async (reason, r) => {
    db.pendingRow = r;
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: reason });
  });

  it('answers WRONG_USER exactly like an unknown id (404 NOT_FOUND)', async () => {
    db.pendingRow = row({ user_id: '44444444-4444-4444-8444-444444444444' });
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('answers 404 NOT_FOUND for an unknown id', async () => {
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('answers 401 without a session', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(401);
    expect(db.calls).toEqual([]);
  });

  it('answers 500 when the gate store fails', async () => {
    db.script.assist_pending_confirm = { error: { message: 'down' } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ decision: 'confirm', nonce: NONCE });
    expect(res.status).toBe(500);
    log.mockRestore();
  });
});
