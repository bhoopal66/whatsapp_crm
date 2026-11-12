import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  enabled: true,
  contact: { data: { id: 'c' }, error: null } as {
    data: unknown;
    error: unknown;
  },
  contactEq: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
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

const CONTACT = '22222222-2222-4222-8222-222222222222';
// The caller's RLS client: only it decides whether the contact is visible.
const supabase = {
  from: () => ({
    select: () => ({
      eq: (k: string, v: string) => {
        m.contactEq(k, v);
        return { maybeSingle: async () => m.contact };
      },
    }),
  }),
};
const asRole = (role: string, salesRestricted = false) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    salesRestricted,
    supabase,
  });
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  m.contact = { data: { id: CONTACT }, error: null };
  asRole('agent');
  m.rpc.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/brain/contact-mark', () => {
  it('marks a visible contact as the session, never the body', async () => {
    const res = await post({
      contactId: CONTACT,
      kind: 'opt_out',
      accountId: 'acct-evil',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.contactEq).toHaveBeenCalledWith('id', CONTACT);
    expect(m.rpc).toHaveBeenCalledWith('brain_contact_mark', {
      p_actor: 'u-1',
      p_account: 'acct-1',
      p_contact: CONTACT,
      p_kind: 'opt_out',
    });
  });

  it('answers 404 for a contact the caller cannot see', async () => {
    m.contact = { data: null, error: null };
    const res = await post({ contactId: CONTACT, kind: 'deletion' });
    expect(res.status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('refuses a viewer, a restricted department and a switched-off account', async () => {
    asRole('viewer');
    expect((await post({ contactId: CONTACT, kind: 'opt_out' })).status).toBe(
      403
    );
    asRole('agent', true);
    expect((await post({ contactId: CONTACT, kind: 'opt_out' })).status).toBe(
      403
    );
    asRole('agent');
    m.enabled = false;
    const res = await post({ contactId: CONTACT, kind: 'opt_out' });
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('maps a SQL NOT_ALLOWED to 403', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', hint: 'NOT_ALLOWED', message: 'x' },
    });
    const res = await post({ contactId: CONTACT, kind: 'opt_out' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED' });
  });

  it('answers 400 for invalid bodies (marks only narrow: no clear)', async () => {
    for (const b of [
      { kind: 'opt_out' },
      { contactId: 'nope', kind: 'opt_out' },
      { contactId: CONTACT, kind: 'clear' },
      { contactId: CONTACT },
    ])
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
