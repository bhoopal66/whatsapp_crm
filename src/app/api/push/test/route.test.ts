import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  pushConfig: vi.fn(),
  rpc: vi.fn(),
  dispatchPush: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/push/config', () => ({ pushConfig: mocks.pushConfig }));
vi.mock('@/lib/push/dispatch', () => ({ dispatchPush: mocks.dispatchPush }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc }),
}));

import { POST } from './route';

type Row = [user: string, kind: string, outcome: string];
/** The dispatch pass reports these rows. */
const pass = (rows: Row[]) =>
  mocks.dispatchPush.mockImplementation(async (_admin, opts) => {
    for (const [user_id, kind, outcome] of rows)
      opts?.onRow?.({ user_id, kind }, outcome);
    return { claimed: rows.length, sent: 9 };
  });

describe('POST /api/push/test', () => {
  // The limiter is module state: a fresh minute for every test.
  let clock = Date.parse('2026-11-28T00:00:00Z');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 120_000;
    vi.setSystemTime(clock);
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      accountId: 'acct-1',
    });
    mocks.pushConfig.mockReturnValue({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:ops@example.com',
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    pass([['user-1', 'test', 'sent']]);
  });

  it('answers 503 push_not_configured with no VAPID keys', async () => {
    mocks.pushConfig.mockReturnValue(null);
    const res = await POST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'push_not_configured' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.dispatchPush).not.toHaveBeenCalled();
  });

  it('queues a test push for the caller and dispatches it now', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'sent' });
    expect(mocks.rpc).toHaveBeenCalledWith('push_enqueue', {
      p_user: 'user-1',
      p_account: 'acct-1',
      p_kind: 'test',
      p_title: 'Test notification',
      p_body: 'Push notifications are working on this device.',
      p_url: '/settings?tab=notifications',
      p_tag: 'test',
    });
    expect(mocks.dispatchPush).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['held', 'held'],
    ['skipped_quiet', 'held'],
    ['skipped', 'no_device'],
    ['failed', 'failed'],
  ])('answers for its own row only: %s', async (outcome, answer) => {
    pass([
      ['user-2', 'test', 'sent'],
      ['user-1', 'test', outcome],
      ['user-1', 'chat_message', 'sent'],
      ['user-2', 'chat_message', 'sent'],
    ]);
    expect(await (await POST()).json()).toEqual({ outcome: answer });
  });

  it('answers queued when another pass took the row', async () => {
    pass([['user-2', 'test', 'sent']]);
    expect(await (await POST()).json()).toEqual({ outcome: 'queued' });
  });

  it('answers no_device, and sends nothing, when the RPC declines', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect(await (await POST()).json()).toEqual({ outcome: 'no_device' });
    expect(mocks.dispatchPush).not.toHaveBeenCalled();
  });

  it('answers 500 without dispatching when the enqueue fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await POST()).status).toBe(500);
    expect(mocks.dispatchPush).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After on the 4th call in a minute, no dispatch', async () => {
    for (let i = 0; i < 3; i++) expect((await POST()).status).toBe(200);
    mocks.dispatchPush.mockClear();
    mocks.rpc.mockClear();
    const res = await POST();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'Too many test notifications. Try again in a minute.',
    });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(mocks.dispatchPush).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('counts per user and frees the budget after the window', async () => {
    for (let i = 0; i < 3; i++) await POST();
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-9',
      accountId: 'acct-1',
    });
    expect((await POST()).status).toBe(200);
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      accountId: 'acct-1',
    });
    vi.setSystemTime(clock + 61_000);
    expect((await POST()).status).toBe(200);
  });
});
