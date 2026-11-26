import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  numbers: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    rpc: m.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ order: () => m.numbers() }) }),
    }),
  }),
}));

import { GET, PUT } from './route';

const V = '2026-11-24T08:00:00.123456+00:00';
const BODY = {
  enabled: true,
  templateName: 'reminder',
  language: 'en',
  sendHour: 10,
  gapDays: 2,
};
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
  m.rpc.mockResolvedValue({ data: null, error: null });
});

describe('PUT /api/desk/digest', () => {
  it('saves against the version the card loaded and answers the new one', async () => {
    for (const expectedUpdatedAt of [V, null]) {
      const res = await put({ ...BODY, expectedUpdatedAt });
      expect(res.status).toBe(200);
      const [fn, args] = m.rpc.mock.lastCall!;
      expect(fn).toBe('desk_digest_settings_set');
      expect(args.p_expected).toBe(expectedUpdatedAt);
      expect((await res.json()).updatedAt).toBe(args.p_now);
    }
  });

  it('refuses an old tab, which names no version, with a 409', async () => {
    const res = await put(BODY);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SETTINGS_CHANGED');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('answers 409 when the SQL finds a newer version', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'SETTINGS_CHANGED', message: 'x' },
    });
    const res = await put({ ...BODY, expectedUpdatedAt: V });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SETTINGS_CHANGED');
  });

  it('refuses a version that is no timestamp before the database', async () => {
    for (const expectedUpdatedAt of ['yesterday', 5, '2026-99-99T00:00:00Z']) {
      const res = await put({ ...BODY, expectedUpdatedAt });
      expect(res.status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/desk/digest', () => {
  it('answers the stored version as it came', async () => {
    m.rpc.mockResolvedValue({ data: [{ updated_at: V }], error: null });
    expect((await (await GET()).json()).settings.updatedAt).toBe(V);
  });
});
