import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  searchBrain: vi.fn(),
  settings: { data: { brain_enabled: true }, error: null } as {
    data: unknown;
    error: unknown;
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => m.settings }) }),
    }),
    rpc: vi.fn(),
  }),
}));
vi.mock('@/lib/brain/search', () => ({ searchBrain: m.searchBrain }));

import { POST } from './route';

const CASE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.settings = { data: { brain_enabled: true }, error: null };
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acct-1',
    role: 'viewer',
    salesRestricted: false,
  });
  m.searchBrain.mockResolvedValue([{ itemId: 'i1' }]);
});

describe('POST /api/brain/search', () => {
  it('searches as the session (never the body) and answers no-store', async () => {
    const res = await post({
      query: '  salary letter  ',
      accountId: 'acct-evil',
      actorId: 'u-evil',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ hits: [{ itemId: 'i1' }] });
    expect(m.searchBrain).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'u-1',
      accountId: 'acct-1',
      query: 'salary letter',
      filters: {},
      limit: undefined,
    });
  });

  it('sends the filters and the limit through', async () => {
    await post({
      query: 'q',
      caseId: CASE,
      contactId: CONTACT,
      bankCode: 'ADCB',
      limit: 5,
    });
    expect(m.searchBrain.mock.calls[0]![1]).toMatchObject({
      filters: { caseId: CASE, contactId: CONTACT, bankCode: 'ADCB' },
      limit: 5,
    });
  });

  it('answers 403 brain_disabled while the switch is off or has no row', async () => {
    m.settings = { data: { brain_enabled: false }, error: null };
    let res = await post({ query: 'q' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'brain_disabled' });
    m.settings = { data: null, error: null };
    res = await post({ query: 'q' });
    expect(res.status).toBe(403);
    expect(m.searchBrain).not.toHaveBeenCalled();
  });

  it('answers 500 (not "on") when the switch cannot be read', async () => {
    m.settings = { data: null, error: { message: 'down' } };
    expect((await post({ query: 'q' })).status).toBe(500);
    expect(m.searchBrain).not.toHaveBeenCalled();
  });

  it('refuses a restricted department', async () => {
    m.getCurrentAccount.mockResolvedValue({
      userId: 'u-1',
      accountId: 'acct-1',
      role: 'agent',
      salesRestricted: true,
    });
    expect((await post({ query: 'q' })).status).toBe(403);
    expect(m.searchBrain).not.toHaveBeenCalled();
  });

  it('answers 400 for invalid bodies', async () => {
    for (const b of [
      { query: '   ' },
      { query: 'x'.repeat(301) },
      { query: 'q', limit: 0 },
      { query: 'q', limit: 51 },
      { query: 'q', limit: 2.5 },
      { query: 'q', caseId: 'nope' },
      { query: 'q', contactId: 7 },
    ])
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect((await post({ query: 'x'.repeat(300), limit: 50 })).status).toBe(
      200
    );
    expect(m.searchBrain).toHaveBeenCalledTimes(1);
  });

  it('never logs the query on a failure', async () => {
    m.searchBrain.mockRejectedValue(new Error('secret query text'));
    expect((await post({ query: 'secret query text' })).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });
});
