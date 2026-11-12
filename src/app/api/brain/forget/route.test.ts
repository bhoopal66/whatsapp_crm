import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  enabled: true,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
// The real SupabaseBrainStore runs on this fake admin client, so the
// RPC arguments and the SQL refusal mapping are exercised too.
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { brain_enabled: m.enabled },
            error: null,
          }),
        }),
      }),
    }),
    rpc: m.rpc,
  }),
}));

import { POST } from './route';

const ITEM = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const asRole = (role: string, salesRestricted = false) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    salesRestricted,
  });
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  asRole('admin');
  m.rpc.mockResolvedValue({ data: 3, error: null });
});

describe('POST /api/brain/forget', () => {
  it('forgets one item as the session, never the body', async () => {
    const res = await post({
      itemId: ITEM,
      reason: ' erasure ',
      accountId: 'acct-evil',
      actorId: 'u-evil',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forgotten: 3 });
    expect(m.rpc).toHaveBeenCalledWith('brain_item_forget', {
      p_actor: 'u-1',
      p_system_label: null,
      p_account: 'acct-1',
      p_item: ITEM,
      p_contact: null,
      p_older_than: null,
      p_reason: 'erasure',
    });
  });

  it('takes the contact and older-than scopes', async () => {
    await post({ contactId: CONTACT, reason: 'r' });
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_contact: CONTACT });
    await post({ olderThan: '2026-01-01T00:00:00Z', reason: 'r' });
    expect(m.rpc.mock.calls[1]![1]).toMatchObject({
      p_older_than: '2026-01-01T00:00:00.000Z',
    });
  });

  it('refuses below admin with no store call', async () => {
    for (const role of ['team_leader', 'agent', 'viewer']) {
      asRole(role);
      expect((await post({ itemId: ITEM, reason: 'r' })).status).toBe(403);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps a SQL NOT_ALLOWED to 403 and ITEM_NOT_FOUND to 404', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', hint: 'NOT_ALLOWED', message: 'x' },
    });
    let res = await post({ itemId: ITEM, reason: 'r' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED' });
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', hint: 'ITEM_NOT_FOUND', message: 'x' },
    });
    res = await post({ itemId: ITEM, reason: 'r' });
    expect(res.status).toBe(404);
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', hint: 'SCOPE_INVALID', message: 'x' },
    });
    res = await post({ itemId: ITEM, reason: 'r' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'SCOPE_INVALID' });
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'x' },
    });
    expect((await post({ itemId: ITEM, reason: 'r' })).status).toBe(500);
  });

  it('refuses a restricted department and a switched-off account', async () => {
    asRole('admin', true);
    expect((await post({ itemId: ITEM, reason: 'r' })).status).toBe(403);
    asRole('admin');
    m.enabled = false;
    const res = await post({ itemId: ITEM, reason: 'r' });
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('answers 400 unless exactly one valid scope and a reason', async () => {
    for (const b of [
      { reason: 'r' },
      { itemId: ITEM, contactId: CONTACT, reason: 'r' },
      { itemId: ITEM, olderThan: '2026-01-01', reason: 'r' },
      { itemId: 'nope', reason: 'r' },
      { olderThan: 'not a date', reason: 'r' },
      { itemId: ITEM },
      { itemId: ITEM, reason: 'x'.repeat(501) },
    ])
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
