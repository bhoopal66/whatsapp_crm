import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { DESK_REFUSAL_HTTP } from '@/lib/desk/http';

import { GET, PUT } from './route';

const G = '11111111-1111-4111-8111-111111111111';
const BODY = {
  groupId: G,
  bankCode: 'RAK',
  intakeEnabled: true,
  repliesEnabled: false,
};
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-active',
    salesRestricted: false,
  });
  m.rpc.mockResolvedValue({ data: null, error: null });
});

describe('GET /api/desk/group-links', () => {
  it('lists the links as the caller in the active account', async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          group_id: G,
          group_name: 'RAK desk',
          bank_code: 'RAK',
          bank_name: 'RAKBANK',
          intake_enabled: true,
          replies_enabled: false,
          updated_by: 'u-2',
          updated_at: '2026-11-28T08:00:00Z',
        },
      ],
      error: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).links).toEqual([
      expect.objectContaining({ groupId: G, bankName: 'RAKBANK' }),
    ]);
    expect(m.rpc).toHaveBeenCalledWith('desk_group_link_list', {
      p_actor: 'u-1',
      p_account: 'acc-active',
    });
  });

  it('a sales-restricted login is refused before the database', async () => {
    m.getCurrentAccount.mockResolvedValue({
      userId: 'u-1',
      accountId: 'acc-active',
      salesRestricted: true,
    });
    expect((await GET()).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('PUT /api/desk/group-links', () => {
  it('saves the link as the caller in the active account', async () => {
    const res = await put(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [fn, args] = m.rpc.mock.lastCall!;
    expect(fn).toBe('desk_group_link_set');
    expect(args).toMatchObject({
      p_actor: 'u-1',
      p_account: 'acc-active',
      p_group: G,
      p_bank_code: 'RAK',
      p_intake: true,
      p_replies: false,
    });
  });

  it('a null bank unlinks', async () => {
    await put({ ...BODY, bankCode: null });
    expect(m.rpc.mock.lastCall![1]).toMatchObject({
      p_bank_code: null,
      p_intake: null,
      p_replies: null,
    });
  });

  it('refuses a malformed body before the database', async () => {
    for (const body of [
      { ...BODY, groupId: 'nope' },
      { ...BODY, bankCode: 5 },
      { ...BODY, bankCode: '  ' },
      { ...BODY, intakeEnabled: 'yes' },
      { ...BODY, repliesEnabled: undefined },
      [],
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps the SQL refusals with DESK_REFUSAL_HTTP', async () => {
    for (const hint of [
      'NOT_ALLOWED',
      'GROUP_NOT_FOUND',
      'BANK_NOT_FOUND',
      'INVALID',
    ] as const) {
      const { status, text } = DESK_REFUSAL_HTTP[hint];
      m.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23514', hint, message: 'x' },
      });
      const res = await put(BODY);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: text, code: hint });
    }
  });
});
