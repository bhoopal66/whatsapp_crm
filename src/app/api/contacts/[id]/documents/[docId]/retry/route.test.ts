import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  eqs: [] as Array<[string, unknown]>,
}));

const from = vi.fn(() => {
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      m.eqs.push([col, val]);
      return chain;
    },
    maybeSingle: m.maybeSingle,
  };
  return chain;
});

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  m.eqs.length = 0;
  m.maybeSingle.mockResolvedValue({ data: { id: DOC }, error: null });
  m.getCurrentAccount.mockResolvedValue({
    supabase: { rpc: m.rpc, from },
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

  it('checks the document belongs to the customer in the path', async () => {
    await post();
    expect(from).toHaveBeenCalledWith('customer_documents');
    expect(m.eqs).toEqual([
      ['id', DOC],
      ['contact_id', ID],
    ]);
  });

  it('is 404 without calling the RPC when the document is not that customer’s', async () => {
    m.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await post();
    expect(res.status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
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
