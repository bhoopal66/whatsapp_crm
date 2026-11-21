import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { POST } from './route';

const FILE = '11111111-1111-4111-8111-111111111111';
const CASE = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const params = { params: Promise.resolve({ fileId: FILE }) };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
});

describe('POST /api/desk/files/[fileId]/link', () => {
  it('links in the active account as the caller', async () => {
    m.rpc.mockResolvedValue({
      data: [{ file_id: 'f2', created: true }],
      error: null,
    });
    const res = await POST(post({ caseId: CASE }), params);
    expect(await res.json()).toEqual({ fileId: 'f2', created: true });
    expect(m.rpc).toHaveBeenCalledWith(
      'desk_doc_link',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_file: FILE,
        p_target: CASE,
      })
    );
  });

  it('answers 409 CONSENT_MISSING and 422 CROSS_CUSTOMER', async () => {
    for (const [hint, status] of [
      ['CONSENT_MISSING', 409],
      ['CROSS_CUSTOMER', 422],
    ] as const) {
      m.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23514', hint, message: 'x' },
      });
      const res = await POST(post({ caseId: CASE }), params);
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(hint);
    }
  });
});
