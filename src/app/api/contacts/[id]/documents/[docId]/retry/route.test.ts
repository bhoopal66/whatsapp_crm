import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    supabase: { rpc: m.rpc },
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'admin',
  });
  m.rpc.mockResolvedValue({ data: 'pending', error: null });
});

import { POST } from './route';

const post = (id = ID, docId = DOC) =>
  POST(new Request(`http://x/api/contacts/${id}/documents/${docId}/retry`), {
    params: Promise.resolve({ id, docId }),
  });

describe('POST /api/contacts/[id]/documents/[docId]/retry', () => {
  it('calls the RPC with the document id and answers its status', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(m.rpc).toHaveBeenCalledWith('customer_documents_retry', {
      p_id: DOC,
    });
  });

  it.each([
    ['NOT_ALLOWED', 403],
    ['NOT_FOUND', 404],
    ['STATE', 409],
  ])('maps hint %s to %i', async (hint, status) => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'refused', hint },
    });
    const res = await post();
    expect(res.status).toBe(status);
    expect(typeof (await res.json()).error).toBe('string');
  });

  it('is 500 for an error with no known hint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'timeout', hint: null },
    });
    expect((await post()).status).toBe(500);
  });

  it('is 400 for ids that are not uuids, without calling the RPC', async () => {
    expect((await post(ID, 'x')).status).toBe(400);
    expect((await post('x', DOC)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
