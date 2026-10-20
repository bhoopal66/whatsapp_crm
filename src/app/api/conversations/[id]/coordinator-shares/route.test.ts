import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { POST } from './route';
import { DELETE } from './[shareId]/route';

const CONV = '11111111-1111-4111-8111-111111111111';
const COORD = '22222222-2222-4222-8222-222222222222';
const SHARE = '33333333-3333-4333-8333-333333333333';

let shareRow: { id: string } | null = null;
const supabase = {
  rpc: mocks.rpc,
  from: () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: shareRow, error: null });
    return q;
  },
};

function post(body: unknown, id = CONV) {
  return POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}
function del(id = CONV, shareId = SHARE) {
  return DELETE(new Request('http://localhost/x', { method: 'DELETE' }), {
    params: Promise.resolve({ id, shareId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  shareRow = null;
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'a',
    userId: 'u',
    role: 'agent',
  });
});

describe('POST coordinator-shares', () => {
  it('validates input', async () => {
    expect(
      (await post({ coordinator_user_id: COORD, bank_code: 'x' })).status
    ).toBe(400);
    expect((await post({ bank_code: 'ADCB' })).status).toBe(400);
    expect(
      (await post({ coordinator_user_id: COORD, bank_code: 'ADCB' }, 'bad'))
        .status
    ).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns the share id', async () => {
    mocks.rpc.mockResolvedValue({ data: SHARE, error: null });
    const res = await post({ coordinator_user_id: COORD, bank_code: 'ADCB' });
    expect(await res.json()).toEqual({ id: SHARE });
    expect(mocks.rpc).toHaveBeenCalledWith(
      'share_conversation_with_coordinator',
      {
        p_conversation_id: CONV,
        p_coordinator_user_id: COORD,
        p_bank_code: 'ADCB',
      }
    );
  });

  it('maps not found and hints', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002' } });
    expect(
      (await post({ coordinator_user_id: COORD, bank_code: 'ADCB' })).status
    ).toBe(404);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', hint: 'not_coordinator' },
    });
    expect(
      (await post({ coordinator_user_id: COORD, bank_code: 'ADCB' })).status
    ).toBe(400);
  });
});

describe('DELETE coordinator-shares/[shareId]', () => {
  it('404s when the share is not on this chat', async () => {
    const res = await del();
    expect(res.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('revokes', async () => {
    shareRow = { id: SHARE };
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const res = await del();
    expect(await res.json()).toEqual({ revoked: true });
    expect(mocks.rpc).toHaveBeenCalledWith('revoke_conversation_share', {
      p_share_id: SHARE,
    });
  });

  it('rejects bad ids', async () => {
    expect((await del('bad')).status).toBe(400);
  });
});
