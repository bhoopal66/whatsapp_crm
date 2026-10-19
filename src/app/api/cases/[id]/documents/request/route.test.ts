import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  countResult: { count: 0, error: null } as {
    count: number | null;
    error: unknown;
  },
  eqs: [] as unknown[][],
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  request: vi.fn(),
  tools: { tag: 'tools' },
  sender: { tag: 'sender' },
  service: vi.fn(),
}));

// The send-limit count: from().select().eq()...gte() resolves to countResult.
const chain: Record<string, unknown> = {};
chain.select = () => chain;
chain.eq = (col: string, val: unknown) => (m.eqs.push([col, val]), chain);
chain.gte = () => Promise.resolve(m.countResult);
const admin = { from: () => chain };

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseToolsStore: () => m.tools,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupService: m.service,
  supabaseAdmin: () => admin,
}));
vi.mock('@/lib/cases/documents', () => ({
  requestMissingDocuments: m.request,
}));

import { CaseRefusedError } from '@/lib/cases/store';

import { POST } from './route';

const USER = 'u-1';
const C = '11111111-1111-4111-8111-111111111111';
const post = () =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: C }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', groupId: 'g-1' });
  m.countResult = { count: 0, error: null };
  m.eqs.length = 0;
  m.role.mockResolvedValue('agent');
  m.service.mockReturnValue(m.sender);
  m.request.mockResolvedValue({
    sent: true,
    docKeys: ['salary'],
    messageId: '7',
    waMessageId: 'wa-1',
    prefixedBody: 'x',
    recorded: true,
    marked: 1,
  });
});

describe('POST documents/request', () => {
  it("sends through the account's group service as the caller", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sent: true,
      docKeys: ['salary'],
      recorded: true,
    });
    expect(m.service).toHaveBeenCalledWith('acct-1', admin);
    expect(m.request).toHaveBeenCalledWith(
      { tools: m.tools, sender: m.sender },
      { caseId: C, actor: 'u-1' }
    );
  });

  it.each([
    [{ sent: false, reason: 'NOTHING_MISSING' }, {}],
    [
      { sent: false, reason: 'BLOCKED', blocked: 'opted_out' },
      { blocked: 'opted_out' },
    ],
    [
      { sent: false, reason: 'REFUSED', refusal: 'SEND_NOT_ALLOWED' },
      { refusal: 'SEND_NOT_ALLOWED' },
    ],
    [{ sent: false, reason: 'SEND_FAILED' }, {}],
  ])('answers 409 with the code for %o', async (result, extra) => {
    m.request.mockResolvedValue(result);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: result.reason, ...extra })
    );
  });

  it("answers 404 for another account's case and sends nothing", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post()).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1', groupId: 'g-1' });
    m.countResult = { count: 0, error: null };
    m.eqs.length = 0;
    m.role.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.request).not.toHaveBeenCalled();
  });

  it('maps a refusal of the begin step', async () => {
    m.request.mockRejectedValue(new CaseRefusedError('CASE_CLOSED'));
    const res = await post();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CASE_CLOSED');
  });
});

describe('documents/request: group send limit', () => {
  it('is 429 SEND_RATE_LIMITED at the limit and does nothing', async () => {
    m.countResult = { count: 20, error: null };
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'SEND_RATE_LIMITED' });
    expect(m.request).not.toHaveBeenCalled();
  });

  it("counts the caller's out rows in the case's group", async () => {
    await post();
    expect(m.eqs).toEqual(
      expect.arrayContaining([
        ['account_id', 'acct-1'],
        ['group_id', 'g-1'],
        ['direction', 'out'],
        ['sender_user_id', USER],
      ])
    );
  });

  it('proceeds under the limit', async () => {
    m.countResult = { count: 19, error: null };
    expect((await post()).status).toBeLessThan(300);
    expect(m.request).toHaveBeenCalled();
  });

  it('is 503 when the count fails, and does nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.countResult = { count: null, error: { message: 'boom' } };
    const res = await post();
    expect(res.status).toBe(503);
    expect(m.request).not.toHaveBeenCalled();
  });
});
