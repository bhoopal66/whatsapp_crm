import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { DELETE, PUT } from './route';
import { GET as LIST } from '../route';
import { GET as FIND } from '../../../route';

const CO = '11111111-1111-4111-8111-111111111111';
const CT = '22222222-2222-4222-8222-222222222222';
const ctx = { userId: 'u-1', accountId: 'acc-1', salesRestricted: false };
const params = (id = CO, contactId = CT) => ({
  params: Promise.resolve({ id, contactId }),
});
const put = (body: unknown) =>
  new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue(ctx);
});

describe('PUT /api/desk/companies/[id]/contacts/[contactId]', () => {
  it('links with the caller as actor in the active account', async () => {
    m.rpc.mockResolvedValue({ data: true, error: null });
    const res = await PUT(put({ role: 'pro', authorised: true }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true });
    expect(m.rpc).toHaveBeenCalledWith(
      'desk_customer_contact_set',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_customer: CO,
        p_contact: CT,
        p_role: 'pro',
        p_authorised: true,
      })
    );
  });

  it('reports an update as not created', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    const res = await PUT(put({ role: 'owner', authorised: false }), params());
    expect(await res.json()).toEqual({ created: false });
  });

  it('refuses a bad role, a non-boolean flag or a bad id before the database', async () => {
    for (const [body, p] of [
      [{ role: 'director', authorised: true }, params()],
      [{ role: 'pro', authorised: 'yes' }, params()],
      [{ role: 'pro', authorised: true }, params('nope')],
    ] as const) {
      const res = await PUT(put(body), p);
      expect(res.status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps the SQL refusals', async () => {
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', hint: 'CUSTOMER_NOT_FOUND', message: 'x' },
    });
    let res = await PUT(put({ role: 'pro', authorised: true }), params());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('CUSTOMER_NOT_FOUND');
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', hint: 'CONTACT_INVALID', message: 'x' },
    });
    res = await PUT(put({ role: 'pro', authorised: true }), params());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CONTACT_INVALID');
  });
});

describe('DELETE, list and find', () => {
  it('unlinks', async () => {
    m.rpc.mockResolvedValue({ data: true, error: null });
    const res = await DELETE(new Request('http://x'), params());
    expect(await res.json()).toEqual({ removed: true });
    expect(m.rpc).toHaveBeenCalledWith('desk_customer_contact_remove', {
      p_actor: 'u-1',
      p_account: 'acc-1',
      p_customer: CO,
      p_contact: CT,
    });
  });

  it("lists a company's contacts", async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          contact_id: CT,
          name: 'Omar',
          phone: '971500000001',
          role: 'pro',
          authorised: true,
          automatic: false,
          created_at: 't1',
          updated_at: 't2',
        },
      ],
      error: null,
    });
    const res = await LIST(new Request('http://x'), {
      params: Promise.resolve({ id: CO }),
    });
    expect((await res.json()).contacts).toEqual([
      {
        contactId: CT,
        name: 'Omar',
        phone: '971500000001',
        role: 'pro',
        authorised: true,
        automatic: false,
        createdAt: 't1',
        updatedAt: 't2',
      },
    ]);
  });

  it('finds companies and needs q', async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          customer_id: CO,
          legal_name: 'Kite',
          trade_licence_no: 'L1',
          app_number: 'TC-26-00001',
          contacts: 2,
          can_manage: true,
        },
      ],
      error: null,
    });
    let res = await FIND(new Request('http://x/api/desk/companies?q=kite'));
    expect((await res.json()).companies[0]).toMatchObject({
      legalName: 'Kite',
      contacts: 2,
      canManage: true,
    });
    res = await FIND(new Request('http://x/api/desk/companies'));
    expect(res.status).toBe(400);
  });
});
