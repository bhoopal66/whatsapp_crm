import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));
vi.mock('@/lib/insights/settings', () => ({ insightsAvailable: () => false }));

import { POST } from './route';

const T = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: T }) };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
});

describe('POST /api/desk/tray/[id]/suggest', () => {
  it('answers off without the insights layer, and files nothing', async () => {
    m.rpc.mockResolvedValue({
      data: {
        candidates: [
          { case_id: 'k', bank_code: 'RAK', product: null, missing: [] },
        ],
      },
      error: null,
    });
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(await res.json()).toEqual({ suggestion: { status: 'off' } });
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
      'desk_tray_suggest_input',
    ]);
  });

  it('maps a refusal for someone who may not sort the item', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { hint: 'TRAY_NOT_FOUND', code: '23514' },
    });
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('TRAY_NOT_FOUND');
  });
});
